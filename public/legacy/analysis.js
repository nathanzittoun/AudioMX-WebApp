// Analysis view rendering: canvases, meters, the waveform selection and the
// FFT/spectrogram panels. The pure DSP this builds on now lives in
// src/core/dsp/ (levels, fft, spectrum) and is published by bridge.ts.

function updateNoiseIndicators(samples) {
  if (!samples || samples.length === 0) {
    return;
  }

  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const absS = Math.abs(s);

    sumSquares += s * s;

    if (absS > peak) {
      peak = absS;
    }

    if (absS > 32000) {
      clipped++;
    }
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  const rmsDb = dbfs(rms);
  const peakDb = dbfs(peak);
  const clippingPercent = (clipped / samples.length) * 100;

  const hum60Mag = goertzelMagnitude(samples, 60, SAMPLE_RATE);
  const hum120Mag = goertzelMagnitude(samples, 120, SAMPLE_RATE);

  const hum60Db = dbfs(hum60Mag);
  const hum120Db = dbfs(hum120Mag);

  rmsDbEl.textContent = rmsDb.toFixed(1) + " dBFS";
  peakDbEl.textContent = peakDb.toFixed(1) + " dBFS";
  clipPercentEl.textContent = clippingPercent.toFixed(2) + "%";

  hum60El.textContent = hum60Db.toFixed(1) + " dB";
  hum120El.textContent = hum120Db.toFixed(1) + " dB";

  rmsBar.style.width = dbToBar(rmsDb) + "%";
  peakBar.style.width = dbToBar(peakDb) + "%";
  clipBar.style.width = clamp(clippingPercent * 20, 0, 100) + "%";
  hum60Bar.style.width = dbToBar(hum60Db) + "%";
  hum120Bar.style.width = dbToBar(hum120Db) + "%";

  if (calibratedNoiseFloorDb !== null) {
    const aboveNoise = rmsDb - calibratedNoiseFloorDb;

    noiseFloorEl.textContent = calibratedNoiseFloorDb.toFixed(1) + " dBFS baseline";

    if (aboveNoise < 3) {
      noiseCommentEl.textContent = "Current input is near the calibrated noise floor.";
    } else if (aboveNoise < 10) {
      noiseCommentEl.textContent = "Current input is slightly above the noise floor.";
    } else {
      noiseCommentEl.textContent = "Current input is clearly above the noise floor.";
    }
  }

  if (clippingPercent > 0.5) {
    noiseCommentEl.textContent = "Clipping detected. Increase PCM_SHIFT in Arduino code to reduce gain.";
  } else if (hum60Db > -35 || hum120Db > -35) {
    noiseCommentEl.textContent = "Strong 60/120 Hz component detected. Possible electrical hum or power noise.";
  }
}

function calibrateNoiseFloor() {
  if (liveSamples.length < SAMPLE_RATE * 0.5) {
    noiseFloorEl.textContent = "Need more silence";
    noiseCommentEl.textContent = "Record at least 1 second of quiet audio, then calibrate.";
    return;
  }

  let sumSquares = 0;

  for (let i = 0; i < liveSamples.length; i++) {
    sumSquares += liveSamples[i] * liveSamples[i];
  }

  const rms = Math.sqrt(sumSquares / liveSamples.length);
  calibratedNoiseFloorDb = dbfs(rms);

  noiseFloorEl.textContent = calibratedNoiseFloorDb.toFixed(1) + " dBFS baseline";
  noiseCommentEl.textContent = "Noise floor calibrated. Now compare speech or silence against it.";

  log("Noise floor calibrated: " + calibratedNoiseFloorDb.toFixed(1) + " dBFS");
}

function drawSpectrumBackground(minFreq = 0, maxFreq = SAMPLE_RATE / 2) {
  spectrumCtx.fillStyle = "#f0f0f2";
  spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);

  spectrumCtx.strokeStyle = "#d8d8dc";
  spectrumCtx.lineWidth = 1;

  for (let i = 0; i <= 5; i++) {
    const y = (spectrumCanvas.height / 5) * i;

    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, y);
    spectrumCtx.lineTo(spectrumCanvas.width, y);
    spectrumCtx.stroke();

    const db = 0 - i * 20;
    spectrumCtx.fillStyle = "#7a7a7d";
    spectrumCtx.font = "12px -apple-system, BlinkMacSystemFont, Arial";
    spectrumCtx.fillText(db + " dB", 8, y + 14);
  }

  for (let i = 0; i <= 8; i++) {
    const x = (spectrumCanvas.width / 8) * i;
    const freq = Math.round(minFreq + (maxFreq - minFreq) * (i / 8));

    spectrumCtx.beginPath();
    spectrumCtx.moveTo(x, 0);
    spectrumCtx.lineTo(x, spectrumCanvas.height);
    spectrumCtx.stroke();

    spectrumCtx.fillStyle = "#7a7a7d";
    spectrumCtx.font = "12px -apple-system, BlinkMacSystemFont, Arial";
    spectrumCtx.fillText(freq + " Hz", x + 6, spectrumCanvas.height - 10);
  }
}

let lastLiveSpectrumDraw = 0;

// Live FFT for the Record page: the frequency content of roughly the last
// 0.25 s of raw audio, redrawn a few times per second next to the waveform.
function drawLiveSpectrum() {
  if (!liveSpectrumCtx) {
    return;
  }

  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  // Throttle so a fast packet rate doesn't trigger an FFT on every chunk.
  if (now - lastLiveSpectrumDraw < 80) {
    return;
  }
  lastLiveSpectrumDraw = now;

  const width = liveSpectrumCanvas.width;
  const height = liveSpectrumCanvas.height;

  liveSpectrumCtx.fillStyle = "#f0f0f2";
  liveSpectrumCtx.fillRect(0, 0, width, height);

  liveSpectrumCtx.strokeStyle = "#e2e2e6";
  liveSpectrumCtx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (height / 4) * i;
    liveSpectrumCtx.beginPath();
    liveSpectrumCtx.moveTo(0, y);
    liveSpectrumCtx.lineTo(width, y);
    liveSpectrumCtx.stroke();
  }

  const windowSize = Math.min(liveSamples.length, 4096);
  if (windowSize < 512) {
    return;
  }

  const slice = Int16Array.from(liveSamples.slice(liveSamples.length - windowSize));
  const spectrum = computeSpectrum(slice);
  if (!spectrum) {
    return;
  }

  // Feed the same FFT frame to the scrolling spectrogram.
  pushLiveSpectrogramColumn(spectrum, now);

  const maxFreq = SAMPLE_RATE / 2;
  const minDb = -100;
  const maxDb = 0;

  liveSpectrumCtx.fillStyle = "#9a9a9d";
  liveSpectrumCtx.font = "11px -apple-system, BlinkMacSystemFont, Arial";

  // Frequency axis (x), labelled in kHz.
  for (let f = 2000; f < maxFreq; f += 2000) {
    const x = (f / maxFreq) * width;
    liveSpectrumCtx.strokeStyle = "#e8e8ec";
    liveSpectrumCtx.beginPath();
    liveSpectrumCtx.moveTo(x, 0);
    liveSpectrumCtx.lineTo(x, height);
    liveSpectrumCtx.stroke();
    liveSpectrumCtx.fillText(f / 1000 + " kHz", x + 3, height - 6);
  }

  // Level axis (y), labelled in dBFS.
  liveSpectrumCtx.fillStyle = "#7a7a7d";
  for (const d of [0, -25, -50, -75]) {
    const y = height - ((d - minDb) / (maxDb - minDb)) * height;
    liveSpectrumCtx.fillText(d + " dBFS", 6, d === 0 ? y + 12 : y - 3);
  }

  liveSpectrumCtx.strokeStyle = "#b31b1b";
  liveSpectrumCtx.lineWidth = 1.6;
  liveSpectrumCtx.beginPath();

  let started = false;
  for (let i = 0; i < spectrum.magnitudes.length; i++) {
    const freq = spectrum.frequencies[i];
    if (freq > maxFreq) {
      break;
    }

    const db = spectrum.magnitudes[i];
    const x = (freq / maxFreq) * width;
    let y = height - ((db - minDb) / (maxDb - minDb)) * height;

    if (y < 0) y = 0;
    if (y > height) y = height;

    if (!started) {
      liveSpectrumCtx.moveTo(x, y);
      started = true;
    } else {
      liveSpectrumCtx.lineTo(x, y);
    }
  }

  liveSpectrumCtx.stroke();
}

// ---------------------------------------------------------------------------
// Spectrogram (time on x, frequency on y, loudness as colour)
// ---------------------------------------------------------------------------

// Display range in dB for the live spectrogram. Absolute levels depend on the
// device gain (PCM_SHIFT); this range gives usable contrast for speech.
const LIVE_SG_MIN_DB = -95;
const LIVE_SG_MAX_DB = -20;

// Scroll speed of the live spectrogram, in pixels per second of audio. Purely
// a rendering choice, so it stays here rather than in core/constants.
const SG_PIXELS_PER_SEC = 120;

// Map a normalized value 0..1 to an [r,g,b] on a dark→purple→red→yellow→white
// ramp (readable in both light and dark surroundings).
function clearLiveSpectrogram() {
  if (!liveSpectrogramCtx) {
    return;
  }

  lastLiveSpectrogramTime = 0;

  liveSpectrogramCtx.fillStyle = "#0e0e14";
  liveSpectrogramCtx.fillRect(
    0,
    0,
    liveSpectrogramCanvas.width,
    liveSpectrogramCanvas.height
  );
}

// Scroll the live spectrogram left by the number of pixels that corresponds to
// the real time elapsed since the last column, and paint the new block from a
// single FFT frame. Advancing by elapsed time (instead of a fixed 1 px) is what
// makes it fill the canvas in a few seconds rather than ~80.
function pushLiveSpectrogramColumn(spectrum, now) {
  if (!liveSpectrogramCtx) {
    return;
  }

  const width = liveSpectrogramCanvas.width;
  const height = liveSpectrogramCanvas.height;
  const maxFreq = SAMPLE_RATE / 2;
  const binCount = spectrum.magnitudes.length;

  let advance;
  if (!lastLiveSpectrogramTime) {
    advance = 8;
  } else {
    advance = Math.round(((now - lastLiveSpectrogramTime) * SG_PIXELS_PER_SEC) / 1000);
  }
  if (advance < 1) advance = 1;
  if (advance > 40) advance = 40; // cap after a pause so it doesn't jump
  lastLiveSpectrogramTime = now;

  // Shift the existing image left by `advance` pixels.
  liveSpectrogramCtx.drawImage(liveSpectrogramCanvas, -advance, 0);

  const column = liveSpectrogramCtx.createImageData(advance, height);

  for (let y = 0; y < height; y++) {
    const freq = (1 - y / height) * maxFreq;
    let bin = Math.round((freq * spectrum.fftSize) / SAMPLE_RATE);
    if (bin < 0) bin = 0;
    if (bin >= binCount) bin = binCount - 1;

    const db = spectrum.magnitudes[bin];
    const t = (db - LIVE_SG_MIN_DB) / (LIVE_SG_MAX_DB - LIVE_SG_MIN_DB);
    const c = spectrogramColor(t);

    for (let xx = 0; xx < advance; xx++) {
      const p = (y * advance + xx) * 4;
      column.data[p] = c[0];
      column.data[p + 1] = c[1];
      column.data[p + 2] = c[2];
      column.data[p + 3] = 255;
    }
  }

  liveSpectrogramCtx.putImageData(column, width - advance, 0);
}

// Render a full static spectrogram of a block of samples (used in the Analyze
// view for the selected region). Auto-scales the colour range to the loudest
// bin so it adapts to the device gain.
function renderStaticSpectrogram(ctx, canvas, samples, sampleRate) {
  if (!ctx || !canvas) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = "#0e0e14";
  ctx.fillRect(0, 0, width, height);

  if (!samples || samples.length < 256) {
    return;
  }

  const windowN = 1024;
  const binCount = windowN / 2;
  const maxFreq = sampleRate / 2;

  const win = new Float32Array(windowN);
  for (let i = 0; i < windowN; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowN - 1)));
  }

  const re = new Float32Array(windowN);
  const im = new Float32Array(windowN);

  const maxStart = Math.max(0, samples.length - windowN);
  const dbGrid = new Float32Array(width * height);
  let peakDb = -Infinity;

  for (let x = 0; x < width; x++) {
    const start =
      maxStart > 0 ? Math.floor((x / (width - 1)) * maxStart) : 0;

    let mean = 0;
    for (let i = 0; i < windowN; i++) {
      const idx = start + i;
      mean += idx < samples.length ? samples[idx] : 0;
    }
    mean /= windowN;

    for (let i = 0; i < windowN; i++) {
      const idx = start + i;
      const v = idx < samples.length ? samples[idx] : 0;
      re[i] = (v - mean) * win[i];
      im[i] = 0;
    }

    fftRadix2(re, im);

    for (let y = 0; y < height; y++) {
      const freq = (1 - y / height) * maxFreq;
      let bin = Math.round((freq * windowN) / sampleRate);
      if (bin < 0) bin = 0;
      if (bin >= binCount) bin = binCount - 1;

      const amp = (2 * Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])) / (windowN * 0.5);
      const db = 20 * Math.log10(amp / 32768 + 1e-12);

      dbGrid[y * width + x] = db;
      if (db > peakDb) {
        peakDb = db;
      }
    }
  }

  const displayMax = peakDb;
  const displayMin = peakDb - 70;

  const img = ctx.createImageData(width, height);
  const data = img.data;

  for (let i = 0; i < dbGrid.length; i++) {
    const t = (dbGrid[i] - displayMin) / (displayMax - displayMin);
    const c = spectrogramColor(t);
    const p = i * 4;
    data[p] = c[0];
    data[p + 1] = c[1];
    data[p + 2] = c[2];
    data[p + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);

  // Frequency axis (y, kHz) and a time-direction hint, drawn on top.
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, Arial";
  for (const f of [2000, 4000, 6000]) {
    const y = height - (f / maxFreq) * height;
    ctx.fillText(f / 1000 + " kHz", 6, y - 3);
  }
  ctx.fillText("time →", width - 52, height - 8);
}

function getFullAnalysisSource() {
  const sourceValue = analysisSourceSelect.value;

  if (sourceValue === "live") {
    return {
      name: "live_buffer",
      samples: Int16Array.from(liveSamples)
    };
  }

  const recordingId = Number(sourceValue.replace("recording-", ""));
  const recording = recordings.find(r => r.id === recordingId);

  if (!recording) {
    return null;
  }

  return {
    name: "recording_" + recording.number + "_" + recording.mode,
    samples: recording.analysisSamples
  };
}

function getSelectedAnalysisSamples() {
  const source = getFullAnalysisSource();

  if (!source || source.samples.length < 2) {
    return null;
  }

  const total = source.samples.length;

  let startIndex = Math.floor(analysisSelectionStart * total);
  let endIndex = Math.floor(analysisSelectionEnd * total);

  startIndex = clamp(startIndex, 0, total - 1);
  endIndex = clamp(endIndex, startIndex + 1, total);

  const selected = source.samples.slice(startIndex, endIndex);

  return {
    name: source.name + "_selected_" + startIndex + "_" + endIndex,
    samples: selected,
    fullSamples: source.samples,
    startIndex,
    endIndex
  };
}

function getAnalysisSamples() {
  return getSelectedAnalysisSamples();
}

function resetAnalysisSelection() {
  analysisSelectionStart = 0;
  analysisSelectionEnd = 1;
  analysisDragMode = null;
  drawAnalysisWaveform();
}

function drawAnalysisWaveform() {
  if (!analysisWaveformCanvas || !analysisWaveformCtx) {
    return;
  }

  const source = getFullAnalysisSource();

  analysisWaveformCtx.fillStyle = "#f0f0f2";
  analysisWaveformCtx.fillRect(
    0,
    0,
    analysisWaveformCanvas.width,
    analysisWaveformCanvas.height
  );

  analysisWaveformCtx.strokeStyle = "#d8d8dc";
  analysisWaveformCtx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = (analysisWaveformCanvas.height / 4) * i;
    analysisWaveformCtx.beginPath();
    analysisWaveformCtx.moveTo(0, y);
    analysisWaveformCtx.lineTo(analysisWaveformCanvas.width, y);
    analysisWaveformCtx.stroke();
  }

  const midY = analysisWaveformCanvas.height / 2;

  analysisWaveformCtx.strokeStyle = "#b8b8bd";
  analysisWaveformCtx.beginPath();
  analysisWaveformCtx.moveTo(0, midY);
  analysisWaveformCtx.lineTo(analysisWaveformCanvas.width, midY);
  analysisWaveformCtx.stroke();

  if (!source || source.samples.length < 2) {
    selectedRangeLabel.textContent = "No waveform available";
    return;
  }

  const samples = source.samples;
  const width = analysisWaveformCanvas.width;
  const height = analysisWaveformCanvas.height;

  analysisWaveformCtx.strokeStyle = "#b31b1b";
  analysisWaveformCtx.lineWidth = 1.5;
  analysisWaveformCtx.beginPath();

  for (let x = 0; x < width; x++) {
    const start = Math.floor((x / width) * samples.length);
    const end = Math.floor(((x + 1) / width) * samples.length);

    let min = 32767;
    let max = -32768;

    for (let i = start; i < end && i < samples.length; i++) {
      const v = samples[i];

      if (v < min) min = v;
      if (v > max) max = v;
    }

    if (min === 32767 && max === -32768) {
      min = 0;
      max = 0;
    }

    const yMin = midY - (min / 32768) * height * 0.42;
    const yMax = midY - (max / 32768) * height * 0.42;

    analysisWaveformCtx.moveTo(x, yMin);
    analysisWaveformCtx.lineTo(x, yMax);
  }

  analysisWaveformCtx.stroke();

  drawSelectionOverlay(source.samples.length);
}

function drawSelectionOverlay(totalSamples) {
  const width = analysisWaveformCanvas.width;
  const height = analysisWaveformCanvas.height;

  const x1 = analysisSelectionStart * width;
  const x2 = analysisSelectionEnd * width;

  analysisWaveformCtx.fillStyle = "rgba(179, 27, 27, 0.16)";
  analysisWaveformCtx.fillRect(x1, 0, x2 - x1, height);

  analysisWaveformCtx.fillStyle = "rgba(0, 0, 0, 0.10)";
  analysisWaveformCtx.fillRect(0, 0, x1, height);
  analysisWaveformCtx.fillRect(x2, 0, width - x2, height);

  analysisWaveformCtx.strokeStyle = "#1d1d1f";
  analysisWaveformCtx.lineWidth = 3;

  analysisWaveformCtx.beginPath();
  analysisWaveformCtx.moveTo(x1, 0);
  analysisWaveformCtx.lineTo(x1, height);
  analysisWaveformCtx.stroke();

  analysisWaveformCtx.beginPath();
  analysisWaveformCtx.moveTo(x2, 0);
  analysisWaveformCtx.lineTo(x2, height);
  analysisWaveformCtx.stroke();

  analysisWaveformCtx.fillStyle = "#1d1d1f";
  analysisWaveformCtx.fillRect(x1 - 5, height / 2 - 22, 10, 44);
  analysisWaveformCtx.fillRect(x2 - 5, height / 2 - 22, 10, 44);

  const startSec = (analysisSelectionStart * totalSamples) / SAMPLE_RATE;
  const endSec = (analysisSelectionEnd * totalSamples) / SAMPLE_RATE;
  const durationSec = endSec - startSec;

  selectedRangeLabel.textContent =
    startSec.toFixed(2) +
    "–" +
    endSec.toFixed(2) +
    " s · " +
    durationSec.toFixed(2) +
    " s selected";
}

function getAnalysisWaveformMousePosition(event) {
  const rect = analysisWaveformCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  return clamp(x / rect.width, 0, 1);
}

let analysisDragOffset = 0;

function beginAnalysisSelectionDrag(event) {
  const pos = getAnalysisWaveformMousePosition(event);

  const leftDistance = Math.abs(pos - analysisSelectionStart);
  const rightDistance = Math.abs(pos - analysisSelectionEnd);

  const handleTolerance = 0.025;

  if (leftDistance < handleTolerance) {
    analysisDragMode = "left";
  } else if (rightDistance < handleTolerance) {
    analysisDragMode = "right";
  } else if (pos > analysisSelectionStart && pos < analysisSelectionEnd) {
    analysisDragMode = "middle";
    analysisDragOffset = pos - analysisSelectionStart;
  } else {
    const width = analysisSelectionEnd - analysisSelectionStart;

    analysisSelectionStart = clamp(pos, 0, 1 - width);
    analysisSelectionEnd = analysisSelectionStart + width;

    analysisDragMode = "middle";
    analysisDragOffset = pos - analysisSelectionStart;

    drawAnalysisWaveform();
    plotNoiseSpectrum();
  }
}

function moveAnalysisSelectionDrag(event) {
  if (!analysisDragMode) {
    return;
  }

  const pos = getAnalysisWaveformMousePosition(event);
  const minWidth = 512 / getCurrentAnalysisSampleCount();

  if (analysisDragMode === "left") {
    analysisSelectionStart = clamp(pos, 0, analysisSelectionEnd - minWidth);
  }

  if (analysisDragMode === "right") {
    analysisSelectionEnd = clamp(pos, analysisSelectionStart + minWidth, 1);
  }

  if (analysisDragMode === "middle") {
    const width = analysisSelectionEnd - analysisSelectionStart;
    let newStart = pos - analysisDragOffset;

    newStart = clamp(newStart, 0, 1 - width);

    analysisSelectionStart = newStart;
    analysisSelectionEnd = newStart + width;
  }

  drawAnalysisWaveform();
  plotNoiseSpectrum();
}

function endAnalysisSelectionDrag() {
  analysisDragMode = null;
}

function getCurrentAnalysisSampleCount() {
  const source = getFullAnalysisSource();

  if (!source || !source.samples) {
    return SAMPLE_RATE;
  }

  return source.samples.length;
}

function initAnalysisWaveformSelection() {
  if (!analysisWaveformCanvas) {
    return;
  }

  analysisWaveformCanvas.addEventListener("mousedown", event => {
    beginAnalysisSelectionDrag(event);
  });

  window.addEventListener("mousemove", event => {
    moveAnalysisSelectionDrag(event);
  });

  window.addEventListener("mouseup", () => {
    endAnalysisSelectionDrag();
  });

  analysisWaveformCanvas.addEventListener("touchstart", event => {
    if (event.touches.length > 0) {
      beginAnalysisSelectionDrag(event.touches[0]);
    }
  });

  window.addEventListener("touchmove", event => {
    if (event.touches.length > 0) {
      moveAnalysisSelectionDrag(event.touches[0]);
    }
  });

  window.addEventListener("touchend", () => {
    endAnalysisSelectionDrag();
  });
}

function plotNoiseSpectrum() {
  drawAnalysisWaveform();

  const source = getAnalysisSamples();

  if (!source || source.samples.length < 1024) {
    dominantFrequenciesEl.textContent = "Need more samples. Select a larger waveform region.";
    fftInterpretationEl.textContent = "Drag the waveform boundaries to select more audio.";
    return;
  }

  const minFreq = clamp(Number(fftMinFreqInput.value) || 0, 0, SAMPLE_RATE / 2);
  const maxFreq = clamp(
    Number(fftMaxFreqInput.value) || SAMPLE_RATE / 2,
    minFreq + 10,
    SAMPLE_RATE / 2
  );

  fftMinFreqInput.value = Math.round(minFreq);
  fftMaxFreqInput.value = Math.round(maxFreq);
  fftRangeLabel.textContent = Math.round(minFreq) + "–" + Math.round(maxFreq) + " Hz";

  const spectrum = computeSpectrum(source.samples);

  if (!spectrum) {
    dominantFrequenciesEl.textContent = "Not enough data for FFT.";
    fftInterpretationEl.textContent = "Select a larger waveform region.";
    return;
  }

  lastSpectrum = spectrum;
  lastSpectrumSourceName = source.name;

  // Spectrogram of the selected region, alongside the averaged FFT.
  renderStaticSpectrogram(
    analysisSpectrogramCtx,
    analysisSpectrogramCanvas,
    source.samples,
    SAMPLE_RATE
  );

  drawSpectrumBackground(minFreq, maxFreq);

  const minDb = -110;
  const maxDb = 0;

  spectrumCtx.strokeStyle = "#b31b1b";
  spectrumCtx.lineWidth = 2.25;
  spectrumCtx.beginPath();

  let started = false;

  for (let i = 0; i < spectrum.magnitudes.length; i++) {
    const freq = spectrum.frequencies[i];

    if (freq < minFreq || freq > maxFreq) {
      continue;
    }

    const db = spectrum.magnitudes[i];

    const x = ((freq - minFreq) / (maxFreq - minFreq)) * spectrumCanvas.width;
    const y = spectrumCanvas.height - ((db - minDb) / (maxDb - minDb)) * spectrumCanvas.height;
    const yClamped = clamp(y, 0, spectrumCanvas.height);

    if (!started) {
      spectrumCtx.moveTo(x, yClamped);
      started = true;
    } else {
      spectrumCtx.lineTo(x, yClamped);
    }
  }

  spectrumCtx.stroke();

  const peaks = findDominantFrequencies(spectrum, minFreq, maxFreq);

  dominantFrequenciesEl.textContent =
    peaks.length === 0
      ? "No clear peaks in this selected region."
      : peaks
          .map(p => Math.round(p.freq) + " Hz (" + p.db.toFixed(1) + " dB)")
          .join(", ");

  fftInterpretationEl.textContent =
    interpretSpectrum(peaks) +
    " FFT averaged over " +
    spectrum.averagedFrames +
    " frame(s) from the selected waveform region.";

  spectrumCtx.fillStyle = "#1d1d1f";
  spectrumCtx.font = "12px -apple-system, BlinkMacSystemFont, Arial";

  for (const peak of peaks.slice(0, 6)) {
    const x = ((peak.freq - minFreq) / (maxFreq - minFreq)) * spectrumCanvas.width;
    const y = spectrumCanvas.height - ((peak.db - minDb) / (maxDb - minDb)) * spectrumCanvas.height;
    const yClamped = clamp(y, 14, spectrumCanvas.height - 22);

    spectrumCtx.beginPath();
    spectrumCtx.arc(x, yClamped, 4, 0, 2 * Math.PI);
    spectrumCtx.fill();

    spectrumCtx.fillText(
      Math.round(peak.freq) + " Hz",
      clamp(x + 7, 8, spectrumCanvas.width - 70),
      yClamped - 7
    );
  }

  downloadFftBtn.disabled = false;

  log(
    "FFT plotted from " +
      source.name +
      " using " +
      source.samples.length +
      " selected samples."
  );
}

function resetFftZoom() {
  fftMinFreqInput.value = 0;
  fftMaxFreqInput.value = SAMPLE_RATE / 2;
  plotNoiseSpectrum();
}

function downloadFftCsv() {
  if (!lastSpectrum) {
    return;
  }

  let csv = "frequency_hz,magnitude_db\n";

  for (let i = 0; i < lastSpectrum.frequencies.length; i++) {
    csv +=
      lastSpectrum.frequencies[i].toFixed(3) +
      "," +
      lastSpectrum.magnitudes[i].toFixed(6) +
      "\n";
  }

  const blob = new Blob([csv], {
    type: "text/csv"
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  a.href = url;
  a.download = "fft_" + lastSpectrumSourceName + "_" + timestamp + ".csv";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);

  log("FFT CSV downloaded.");
}