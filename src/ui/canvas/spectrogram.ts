// Spectrogram rendering: time on x, frequency on y, loudness as colour.
//
// Two of them, with different jobs. The live one scrolls during a capture and
// is fed one FFT frame at a time by the Record page. The static one renders a
// whole block of samples at once for the Analyze view, and re-runs its own
// FFT because it needs one column per pixel, not one per audio frame.
//
// Both draw; neither computes anything a caller could reuse. The maths they
// build on lives in core/dsp/, the colour ramp next door in spectrogramColor.

import { fftRadix2 } from "../../core/dsp/fft";
import { SAMPLE_RATE } from "../../core/constants";
import { ctx2d, el } from "../dom";
import { PLOT } from "../theme";
import { spectrogramColor } from "./spectrogramColor";

/** A single averaged FFT frame, as computeSpectrum() returns it. */
interface SpectrumFrame {
  magnitudes: Float32Array;
  fftSize: number;
}

// Display range in dB for the live spectrogram. Absolute levels depend on the
// device gain (PCM_SHIFT); this range gives usable contrast for speech.
const LIVE_MIN_DB = -95;
const LIVE_MAX_DB = -20;

// Scroll speed of the live spectrogram, in pixels per second of audio.
const PIXELS_PER_SEC = 120;

/**
 * Timestamp of the last painted column, 0 when the canvas is blank.
 *
 * Module state now; in analysis.js it was an *implicit* global — assigned
 * without a declaration, which only works because classic scripts are sloppy
 * mode. The same line inside a module throws a ReferenceError, so this is one
 * of the things the conversion has to make explicit rather than move.
 */
let lastColumnTime = 0;

const liveCanvas = (): HTMLCanvasElement | null => el<HTMLCanvasElement>("liveSpectrogram");
const liveCtx = (): CanvasRenderingContext2D | null => ctx2d("liveSpectrogram");

export function clearLiveSpectrogram(): void {
  const ctx = liveCtx();
  const canvas = liveCanvas();
  if (!ctx || !canvas) return;

  lastColumnTime = 0;

  ctx.fillStyle = PLOT.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/**
 * Scroll the live spectrogram left by the number of pixels that corresponds to
 * the real time elapsed since the last column, and paint the new block from a
 * single FFT frame. Advancing by elapsed time (instead of a fixed 1 px) is what
 * makes it fill the canvas in a few seconds rather than ~80.
 */
export function pushLiveSpectrogramColumn(spectrum: SpectrumFrame, now: number): void {
  const ctx = liveCtx();
  const canvas = liveCanvas();
  if (!ctx || !canvas) return;

  const width = canvas.width;
  const height = canvas.height;
  const maxFreq = SAMPLE_RATE / 2;
  const binCount = spectrum.magnitudes.length;

  let advance = lastColumnTime
    ? Math.round(((now - lastColumnTime) * PIXELS_PER_SEC) / 1000)
    : 8;
  if (advance < 1) advance = 1;
  if (advance > 40) advance = 40; // cap after a pause so it doesn't jump
  lastColumnTime = now;

  // Shift the existing image left by `advance` pixels.
  ctx.drawImage(canvas, -advance, 0);

  const column = ctx.createImageData(advance, height);

  for (let y = 0; y < height; y++) {
    const freq = (1 - y / height) * maxFreq;
    let bin = Math.round((freq * spectrum.fftSize) / SAMPLE_RATE);
    if (bin < 0) bin = 0;
    if (bin >= binCount) bin = binCount - 1;

    const db = spectrum.magnitudes[bin];
    const t = (db - LIVE_MIN_DB) / (LIVE_MAX_DB - LIVE_MIN_DB);
    const c = spectrogramColor(t);

    for (let xx = 0; xx < advance; xx++) {
      const p = (y * advance + xx) * 4;
      column.data[p] = c[0];
      column.data[p + 1] = c[1];
      column.data[p + 2] = c[2];
      column.data[p + 3] = 255;
    }
  }

  ctx.putImageData(column, width - advance, 0);
}

/**
 * Render a full static spectrogram of a block of samples (used in the Analyze
 * view for the selected region). Auto-scales the colour range to the loudest
 * bin so it adapts to the device gain.
 */
export function renderStaticSpectrogram(
  ctx: CanvasRenderingContext2D | null,
  canvas: HTMLCanvasElement | null,
  samples: ArrayLike<number> | null,
  sampleRate: number
): void {
  if (!ctx || !canvas) return;

  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = PLOT.bg;
  ctx.fillRect(0, 0, width, height);

  if (!samples || samples.length < 256) return;

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
    const start = maxStart > 0 ? Math.floor((x / (width - 1)) * maxStart) : 0;

    // Removing the DC offset per column: a biased mic would otherwise light up
    // the bottom row and skew the auto-scaled colour range.
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
      if (db > peakDb) peakDb = db;
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
  ctx.fillStyle = PLOT.label;
  ctx.font = "11px -apple-system, BlinkMacSystemFont, Arial";
  for (const f of [2000, 4000, 6000]) {
    const y = height - (f / maxFreq) * height;
    ctx.fillText(f / 1000 + " kHz", 6, y - 3);
  }
  ctx.fillText("time →", width - 52, height - 8);
}
