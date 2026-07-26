class BiquadFilter {
  constructor(type, frequency, q, sampleRate) {
    this.type = type;
    this.frequency = frequency;
    this.q = q;
    this.sampleRate = sampleRate;

    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;

    this.calculateCoefficients();
  }

  calculateCoefficients() {
    const w0 = 2 * Math.PI * this.frequency / this.sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * this.q);

    let b0;
    let b1;
    let b2;
    let a0;
    let a1;
    let a2;

    if (this.type === "highpass") {
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    }

    if (this.type === "notch") {
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    }

    if (this.type === "lowpass") {
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    }

    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x) {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;

    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;

    return y;
  }

  reset() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

let noiseFilterChains = [];
// Per-channel gate state: { env, gain }.
let noiseGateStates = [];

function createNoiseFilterChain() {
  // Strong voice-cleanup chain, baked into the recording when the filter is ON.
  //   - Three cascaded high-passes at 130 Hz (~36 dB/oct): crush the ESP32 low
  //     comb (31/62/94 Hz) and rumble.
  //   - 60/120/180 Hz notches: mains hum + its harmonic.
  //   - Low-pass at 7 kHz: trims high-frequency hiss above the speech band.
  // Speech (roughly 150 Hz – 6 kHz) passes; the noise around it is cut hard.
  return [
    new BiquadFilter("highpass", 130, 0.707, SAMPLE_RATE),
    new BiquadFilter("highpass", 130, 0.707, SAMPLE_RATE),
    new BiquadFilter("highpass", 130, 0.707, SAMPLE_RATE),
    new BiquadFilter("notch", 60, 20, SAMPLE_RATE),
    new BiquadFilter("notch", 120, 20, SAMPLE_RATE),
    new BiquadFilter("notch", 180, 20, SAMPLE_RATE),
    new BiquadFilter("lowpass", 7000, 0.707, SAMPLE_RATE)
  ];
}

function resetNoiseAttenuator() {
  noiseFilterChains = [
    createNoiseFilterChain(),
    createNoiseFilterChain()
  ];

  noiseGateStates = [
    { env: 0, gain: 1 },
    { env: 0, gain: 1 }
  ];
}

function toggleNoiseAttenuator() {
  noiseAttenuatorEnabled = !noiseAttenuatorEnabled;

  noiseAttenuatorBtn.classList.toggle("noiseOn", noiseAttenuatorEnabled);

  if (noiseAttenuatorEnabled) {
    noiseAttenuatorBtn.textContent = "Noise filter ON";
    log("Noise filter ON: recordings are cleaned (high-pass + notches + low-pass + gate). Turn OFF for the raw signal.");
  } else {
    noiseAttenuatorBtn.textContent = "Noise filter OFF";
    log("Noise filter OFF: recordings are raw.");
  }

  resetNoiseAttenuator();
}

function processNoiseAttenuator(samples, channelCount) {
  if (!noiseAttenuatorEnabled) {
    return samples;
  }

  const output = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    const channel = channelCount === 2 ? i % 2 : 0;

    let x = samples[i] / 32768;

    const chain = noiseFilterChains[channel];

    for (let j = 0; j < chain.length; j++) {
      x = chain[j].process(x);
    }

    x = applySoftNoiseGate(x, noiseGateStates[channel]);

    if (x > 1) x = 1;
    if (x < -1) x = -1;

    output[i] = Math.round(x * 32767);
  }

  return output;
}

// Gate thresholds, in dBFS on the envelope (not on a single sample). Aggressive
// so pauses go essentially silent (obvious cleanup): anything below the
// threshold is pushed toward a very low floor.
const NOISE_GATE_THRESHOLD_DB = -38; // above this the gate is fully open
const NOISE_GATE_RANGE_DB = 8;       // dB below threshold to reach the floor
const NOISE_GATE_FLOOR_GAIN = 0.02;  // residual gain when fully closed (~ -34 dB)

// Envelope follower: fast attack, slow release, so the level estimate tracks
// the signal's magnitude rather than an individual sample. Coefficients are
// per-sample one-pole smoothing factors for the 16 kHz stream.
const ENV_ATTACK = 0.7;   // ~0.2 ms toward a rising level
const ENV_RELEASE = 0.9995; // ~125 ms decay

// Gain smoothing: open quickly so speech onsets aren't clipped, close slowly
// so the gate doesn't chatter between words.
const GATE_OPEN_SMOOTH = 0.5;
const GATE_CLOSE_SMOOTH = 0.995;

// One gate step for a single sample. `state` is a mutable { env, gain } object,
// so the same routine serves both the live per-channel gate and the offline
// render below.
function applySoftNoiseGate(x, state) {
  const absX = Math.abs(x);

  // 1) Track the signal envelope instead of the instantaneous sample. The old
  //    code read |x| directly, so every zero-crossing looked like silence and
  //    the gate modulated the gain within a single cycle (audible distortion).
  if (absX > state.env) {
    state.env = ENV_ATTACK * state.env + (1 - ENV_ATTACK) * absX;
  } else {
    state.env = ENV_RELEASE * state.env + (1 - ENV_RELEASE) * absX;
  }

  // 2) Map the envelope level to a target gain with a soft (linear-in-dB) knee.
  const db = 20 * Math.log10(state.env + 1e-9);

  let targetGain;

  if (db >= NOISE_GATE_THRESHOLD_DB) {
    targetGain = 1;
  } else {
    const belowThreshold = NOISE_GATE_THRESHOLD_DB - db;
    const t = Math.min(Math.max(belowThreshold / NOISE_GATE_RANGE_DB, 0), 1);
    targetGain = 1 + t * (NOISE_GATE_FLOOR_GAIN - 1);
  }

  // 3) Smooth the applied gain: fast to open, slow to close.
  const smoothing = targetGain > state.gain ? GATE_OPEN_SMOOTH : GATE_CLOSE_SMOOTH;
  state.gain = smoothing * state.gain + (1 - smoothing) * targetGain;

  return x * state.gain;
}

// Apply the same high-pass + notch + gate chain to a finished recording, using
// fresh state and independent of the live preview toggle. This lets us render a
// "filtered" copy for listening while the stored raw signal stays untouched.
function applyFilterOffline(samples, channelCount) {
  const chains = [createNoiseFilterChain(), createNoiseFilterChain()];
  const states = [
    { env: 0, gain: 1 },
    { env: 0, gain: 1 }
  ];

  const output = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    const channel = channelCount === 2 ? i % 2 : 0;

    let x = samples[i] / 32768;

    const chain = chains[channel];
    for (let j = 0; j < chain.length; j++) {
      x = chain[j].process(x);
    }

    x = applySoftNoiseGate(x, states[channel]);

    if (x > 1) x = 1;
    if (x < -1) x = -1;

    output[i] = Math.round(x * 32767);
  }

  return output;
}