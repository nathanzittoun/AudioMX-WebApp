// Acoustic voice-feature extraction (research preview) — computed in-browser
// from a mono int16 signal. These are the classic voice-biomarker measures and
// the natural place a trained model plugs in later.
//
// Estimates are frame-based (F0, HNR, jitter, shimmer) plus an LPC formant
// estimate. True Praat-grade jitter/shimmer need glottal-cycle marking; these
// are close enough to visualize the pipeline and drive an AI hook.

function fx_autocorrPeak(frame, minLag, maxLag) {
  const n = frame.length;
  let bestLag = -1, bestR = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      s += frame[i] * frame[i + lag];
      e1 += frame[i] * frame[i];
      e2 += frame[i + lag] * frame[i + lag];
    }
    const denom = Math.sqrt(e1 * e2);
    const norm = denom > 0 ? s / denom : 0; // normalized cross-correlation ∈ [-1,1]
    if (norm > bestR) { bestR = norm; bestLag = lag; }
  }
  return { lag: bestLag, r: bestR };
}

function fx_autocorr(x, order) {
  const R = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let i = 0; i < x.length - k; i++) s += x[i] * x[i + k];
    R[k] = s;
  }
  return R;
}

function fx_levinson(R, order) {
  if (R[0] === 0) return null;
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let e = R[0];
  for (let i = 1; i <= order; i++) {
    let acc = R[i];
    for (let j = 1; j < i; j++) acc += a[j] * R[i - j];
    const k = -acc / e;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    e *= (1 - k * k);
    if (e <= 0) return null;
  }
  return a;
}

// Approximate F1/F2 from the LPC spectral envelope peaks.
function fx_formants(samples, sampleRate) {
  const winLen = Math.min(samples.length, Math.round(0.03 * sampleRate));
  if (winLen < 128) return { f1: null, f2: null };
  const startIdx = Math.floor((samples.length - winLen) / 2);

  let mean = 0;
  for (let i = 0; i < winLen; i++) mean += samples[startIdx + i];
  mean /= winLen;

  const x = new Float64Array(winLen);
  let prev = 0;
  for (let i = 0; i < winLen; i++) {
    const s = samples[startIdx + i] - mean;
    const pe = s - 0.97 * prev; // pre-emphasis
    prev = s;
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winLen - 1)));
    x[i] = pe * w;
  }

  const order = 12;
  const a = fx_levinson(fx_autocorr(x, order), order);
  if (!a) return { f1: null, f2: null };

  const maxFreq = 5000;
  const steps = 512;
  const mags = new Float64Array(steps);
  for (let s = 0; s < steps; s++) {
    const f = (s / steps) * maxFreq;
    const w = (2 * Math.PI * f) / sampleRate;
    let re = 0, im = 0;
    for (let m = 0; m <= order; m++) {
      re += a[m] * Math.cos(-w * m);
      im += a[m] * Math.sin(-w * m);
    }
    mags[s] = 1 / Math.sqrt(re * re + im * im + 1e-12);
  }

  const peaks = [];
  for (let s = 1; s < steps - 1; s++) {
    if (mags[s] > mags[s - 1] && mags[s] > mags[s + 1]) {
      peaks.push({ f: (s / steps) * maxFreq, mag: mags[s] });
    }
  }
  peaks.sort((p, q) => p.f - q.f);
  const usable = peaks.filter(p => p.f > 200);
  return {
    f1: usable[0] ? Math.round(usable[0].f) : null,
    f2: usable[1] ? Math.round(usable[1].f) : null
  };
}

function extractVoiceFeatures(samples, sampleRate) {
  if (!samples || samples.length < sampleRate * 0.15) return null;

  const N = samples.length;
  const frameLen = Math.round(0.04 * sampleRate);
  const hop = Math.round(0.01 * sampleRate);
  const minF0 = 70, maxF0 = 400;
  const minLag = Math.floor(sampleRate / maxF0);
  const maxLag = Math.ceil(sampleRate / minF0);
  const voicedThresh = 0.35;

  const f0s = [], periods = [], amps = [], hnrs = [];
  let voicedFrames = 0, totalFrames = 0;

  for (let start = 0; start + frameLen <= N; start += hop) {
    totalFrames++;
    let mean = 0;
    for (let i = 0; i < frameLen; i++) mean += samples[start + i];
    mean /= frameLen;

    const frame = new Float64Array(frameLen);
    let rms = 0, peak = 0;
    for (let i = 0; i < frameLen; i++) {
      const v = samples[start + i] - mean;
      frame[i] = v;
      rms += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    rms = Math.sqrt(rms / frameLen);
    if (rms < 40) continue; // skip near-silence

    const { lag, r } = fx_autocorrPeak(frame, minLag, maxLag);
    if (lag > 0 && r > voicedThresh) {
      voicedFrames++;
      f0s.push(sampleRate / lag);
      periods.push(lag / sampleRate);
      amps.push(peak);
      const rr = Math.min(0.9999, Math.max(0.0001, r));
      hnrs.push(10 * Math.log10(rr / (1 - rr)));
    }
  }

  const voicedFraction = voicedFrames / Math.max(1, totalFrames);
  if (f0s.length < 3) {
    return { voiced: false, voicedFraction: voicedFraction };
  }

  const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length;
  const meanF0 = mean(f0s);
  const f0sd = Math.sqrt(mean(f0s.map(x => (x - meanF0) * (x - meanF0))));

  let jd = 0;
  for (let i = 1; i < periods.length; i++) jd += Math.abs(periods[i] - periods[i - 1]);
  const jitterPct = (jd / (periods.length - 1)) / mean(periods) * 100;

  let sd = 0;
  for (let i = 1; i < amps.length; i++) sd += Math.abs(amps[i] - amps[i - 1]);
  const shimmerPct = (sd / (amps.length - 1)) / mean(amps) * 100;

  const formants = fx_formants(samples, sampleRate);

  return {
    voiced: true,
    voicedFraction: voicedFraction,
    f0: meanF0,
    f0sd: f0sd,
    jitterPct: jitterPct,
    shimmerPct: shimmerPct,
    hnrDb: mean(hnrs),
    f1: formants.f1,
    f2: formants.f2
  };
}

// Compact one-line summary for a chart row.
function formatFeatures(f) {
  if (!f) return "—";
  if (!f.voiced) return "unvoiced / no clear pitch (" + Math.round(f.voicedFraction * 100) + "% voiced)";
  return "F0 " + f.f0.toFixed(0) + " Hz · jitter " + f.jitterPct.toFixed(2) +
    "% · shimmer " + f.shimmerPct.toFixed(1) + "% · HNR " + f.hnrDb.toFixed(1) + " dB" +
    (f.f1 ? " · F1 " + f.f1 + " / F2 " + (f.f2 || "?") + " Hz" : "");
}
