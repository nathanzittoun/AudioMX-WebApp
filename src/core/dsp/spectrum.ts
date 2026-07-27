// Averaged (Welch) spectrum estimation and peak interpretation. Pure DSP —
// the drawing of these results lives in the R&D analyse view.

import { FFT_SIZE, SAMPLE_RATE } from "../constants";
import { accumulateFftFrame, nextPowerOfTwo } from "./fft";
import type { Spectrum } from "../state";

export interface SpectralPeak {
  freq: number;
  db: number;
}

/**
 * Welch-averaged magnitude spectrum in dBFS, or null when the region is too
 * short to transform. Calibrated so a full-scale sine reads about 0 dBFS.
 */
export function computeSpectrum(samples: ArrayLike<number> | null | undefined): Spectrum | null {
  if (!samples || samples.length < 512) {
    return null;
  }

  const N = Math.min(FFT_SIZE, nextPowerOfTwo(samples.length));

  if (N < 512) {
    return null;
  }

  const hopSize = Math.floor(N / 2);
  const binCount = Math.floor(N / 2);

  const accumulatedPower = new Float64Array(binCount);
  const frequencies = new Float32Array(binCount);

  for (let k = 0; k < binCount; k++) {
    frequencies[k] = (k * SAMPLE_RATE) / N;
  }

  let frameCounter = 0;

  if (samples.length <= N) {
    accumulateFftFrame(samples, 0, N, accumulatedPower);
    frameCounter = 1;
  } else {
    for (let start = 0; start + N <= samples.length; start += hopSize) {
      accumulateFftFrame(samples, start, N, accumulatedPower);
      frameCounter++;
    }
  }

  if (frameCounter === 0) {
    return null;
  }

  const magnitudes = new Float32Array(binCount);

  // Hann window coherent gain (mean of the window). Dividing by it undoes the
  // ~6 dB the window subtracts, so a full-scale sine reads ~0 dBFS.
  const WINDOW_COHERENT_GAIN = 0.5;

  for (let k = 0; k < binCount; k++) {
    // Average power across frames (Welch), then take the RMS bin magnitude.
    const binMag = Math.sqrt(accumulatedPower[k] / frameCounter);

    // Convert the raw bin magnitude to a calibrated tone amplitude:
    //   - divide by N and the window gain,
    //   - apply the one-sided factor of 2 (DC bin excluded).
    const oneSided = k === 0 ? 1 : 2;
    const amplitude = (oneSided * binMag) / (N * WINDOW_COHERENT_GAIN);

    magnitudes[k] = 20 * Math.log10(amplitude / 32768 + 1e-12);
  }

  return {
    frequencies,
    magnitudes,
    fftSize: N,
    sampleRate: SAMPLE_RATE,
    averagedFrames: frameCounter
  };
}

/** Local maxima within the range, strongest first, within 35 dB of the top. */
export function findDominantFrequencies(
  spectrum: Spectrum,
  minFreq: number,
  maxFreq: number
): SpectralPeak[] {
  const peaks: SpectralPeak[] = [];

  for (let i = 2; i < spectrum.magnitudes.length - 2; i++) {
    const freq = spectrum.frequencies[i];
    const db = spectrum.magnitudes[i];

    if (freq < minFreq || freq > maxFreq || freq < 20) {
      continue;
    }

    const isLocalPeak =
      db > spectrum.magnitudes[i - 1] &&
      db > spectrum.magnitudes[i + 1] &&
      db > spectrum.magnitudes[i - 2] &&
      db > spectrum.magnitudes[i + 2];

    if (isLocalPeak) {
      peaks.push({ freq, db });
    }
  }

  peaks.sort((a, b) => b.db - a.db);

  if (peaks.length === 0) {
    return [];
  }

  const strongestDb = peaks[0].db;

  return peaks
    .filter(p => p.db >= strongestDb - 35 && p.db > -110)
    .slice(0, 10);
}

/** Plain-language reading of the peaks, for the analyse panel. */
export function interpretSpectrum(peaks: SpectralPeak[] | null | undefined): string {
  if (!peaks || peaks.length === 0) {
    return "No clear dominant peaks detected in this selected region.";
  }

  const peakFreqs = peaks.map(p => p.freq);
  const has60 = peakFreqs.some(f => Math.abs(f - 60) < 8);
  const has120 = peakFreqs.some(f => Math.abs(f - 120) < 10);
  const hasLow = peakFreqs.some(f => f < 150);
  const hasHigh = peakFreqs.some(f => f > 3000);

  const messages: string[] = [];

  if (has60) {
    messages.push("Peak near 60 Hz: possible electrical hum or USB/power noise.");
  }

  if (has120) {
    messages.push("Peak near 120 Hz: possible power harmonic.");
  }

  if (hasLow) {
    messages.push("Low-frequency peaks: possible rumble, vibration, handling, or environmental noise.");
  }

  if (hasHigh) {
    messages.push("High-frequency peaks: possible hiss, digital artifact, or sharp acoustic source.");
  }

  if (messages.length === 0) {
    messages.push("Peaks are present, but none match the usual 60/120 Hz or low-rumble patterns.");
  }

  return messages.join(" ");
}
