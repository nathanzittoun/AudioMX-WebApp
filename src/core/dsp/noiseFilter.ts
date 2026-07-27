// Voice-cleanup chain: cascaded high-passes + mains notches + low-pass, followed
// by a soft noise gate. Baked into the stored take when the filter is ON; the
// raw signal is stored when it is OFF.

import { BiquadFilter } from "./biquad";
import { SAMPLE_RATE } from "../constants";
import { capture } from "../state";

/** Mutable per-channel gate state. */
export interface GateState {
  env: number;
  gain: number;
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
const ENV_ATTACK = 0.7;     // ~0.2 ms toward a rising level
const ENV_RELEASE = 0.9995; // ~125 ms decay

// Gain smoothing: open quickly so speech onsets aren't clipped, close slowly
// so the gate doesn't chatter between words.
const GATE_OPEN_SMOOTH = 0.5;
const GATE_CLOSE_SMOOTH = 0.995;

/**
 * Strong voice-cleanup chain, baked into the recording when the filter is ON.
 *   - Three cascaded high-passes at 130 Hz (~36 dB/oct): crush the ESP32 low
 *     comb (31/62/94 Hz) and rumble.
 *   - 60/120/180 Hz notches: mains hum + its harmonic.
 *   - Low-pass at 7 kHz: trims high-frequency hiss above the speech band.
 * Speech (roughly 150 Hz – 6 kHz) passes; the noise around it is cut hard.
 */
export function createNoiseFilterChain(sampleRate: number): BiquadFilter[] {
  return [
    new BiquadFilter("highpass", 130, 0.707, sampleRate),
    new BiquadFilter("highpass", 130, 0.707, sampleRate),
    new BiquadFilter("highpass", 130, 0.707, sampleRate),
    new BiquadFilter("notch", 60, 20, sampleRate),
    new BiquadFilter("notch", 120, 20, sampleRate),
    new BiquadFilter("notch", 180, 20, sampleRate),
    new BiquadFilter("lowpass", 7000, 0.707, sampleRate)
  ];
}

const freshGate = (): GateState => ({ env: 0, gain: 1 });

// Live per-channel state, rebuilt whenever a take starts or the toggle flips.
let noiseFilterChains: BiquadFilter[][] = [];
let noiseGateStates: GateState[] = [];

export function resetNoiseAttenuator(): void {
  noiseFilterChains = [
    createNoiseFilterChain(SAMPLE_RATE),
    createNoiseFilterChain(SAMPLE_RATE)
  ];
  noiseGateStates = [freshGate(), freshGate()];
}

/**
 * One gate step for a single sample. `state` is mutated in place, so the same
 * routine serves both the live per-channel gate and the offline render.
 */
export function applySoftNoiseGate(x: number, state: GateState): number {
  const absX = Math.abs(x);

  // 1) Track the signal envelope instead of the instantaneous sample. Reading
  //    |x| directly makes every zero-crossing look like silence, so the gate
  //    modulates gain within a single cycle — audible as distortion.
  if (absX > state.env) {
    state.env = ENV_ATTACK * state.env + (1 - ENV_ATTACK) * absX;
  } else {
    state.env = ENV_RELEASE * state.env + (1 - ENV_RELEASE) * absX;
  }

  // 2) Map the envelope level to a target gain with a soft (linear-in-dB) knee.
  const db = 20 * Math.log10(state.env + 1e-9);

  let targetGain: number;
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

/** Shared inner loop for the live and offline paths. */
function runChain(
  samples: Int16Array,
  channelCount: number,
  chains: BiquadFilter[][],
  states: GateState[]
): Int16Array {
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

/** Live path: a no-op passthrough while the filter is OFF. */
export function processNoiseAttenuator(samples: Int16Array, channelCount: number): Int16Array {
  if (!capture.noiseFilterEnabled) {
    return samples;
  }
  return runChain(samples, channelCount, noiseFilterChains, noiseGateStates);
}

/**
 * Apply the same chain to a finished recording with fresh state, independent of
 * the live toggle — for rendering a "filtered" copy to listen to while the
 * stored raw signal stays untouched. Currently unused by the UI.
 */
export function applyFilterOffline(samples: Int16Array, channelCount: number): Int16Array {
  return runChain(
    samples,
    channelCount,
    [createNoiseFilterChain(SAMPLE_RATE), createNoiseFilterChain(SAMPLE_RATE)],
    [freshGate(), freshGate()]
  );
}
