// The live FFT strip on the Record page: the frequency content of roughly the
// last quarter second, redrawn a few times per second beside the waveform.
//
// It also drives the scrolling spectrogram. One FFT feeds both displays, which
// is why the call sits here rather than in the render loop: computing the same
// frame twice per tick was measurable at 16 kHz.

import { SAMPLE_RATE } from "../core/constants";
import { capture } from "../core/state";
import { computeSpectrum } from "../core/dsp/spectrum";
import { ctx2d, el } from "../ui/dom";
import { PLOT } from "../ui/theme";
import { pushLiveSpectrogramColumn } from "../ui/canvas/spectrogram";

/** Redraw interval, ms. A fast packet rate must not trigger an FFT per chunk. */
const MIN_REDRAW_MS = 80;

/** Longest window we transform, and the shortest one worth transforming. */
const MAX_WINDOW = 4096;
const MIN_WINDOW = 512;

const DISPLAY_MIN_DB = -100;
const DISPLAY_MAX_DB = 0;

let lastDraw = 0;

export function drawLiveSpectrum(): void {
  const ctx = ctx2d("liveSpectrum");
  const canvas = el<HTMLCanvasElement>("liveSpectrum");
  if (!ctx || !canvas) return;

  const now = typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();

  if (now - lastDraw < MIN_REDRAW_MS) return;
  lastDraw = now;

  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = "#f0f0f2";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#e2e2e6";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const live = capture.live;
  const windowSize = Math.min(live.length, MAX_WINDOW);
  // Below this the FFT resolution is too coarse to be worth drawing; the grid
  // stays on screen so the panel does not flicker between empty and full.
  if (windowSize < MIN_WINDOW) return;

  const slice = Int16Array.from(live.slice(live.length - windowSize));
  const spectrum = computeSpectrum(slice);
  if (!spectrum) return;

  // Feed the same FFT frame to the scrolling spectrogram.
  pushLiveSpectrogramColumn(spectrum, now);

  const maxFreq = SAMPLE_RATE / 2;
  const toY = (db: number): number =>
    height - ((db - DISPLAY_MIN_DB) / (DISPLAY_MAX_DB - DISPLAY_MIN_DB)) * height;

  ctx.fillStyle = "#9a9a9d";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, Arial";

  // Frequency axis (x), labelled in kHz.
  for (let f = 2000; f < maxFreq; f += 2000) {
    const x = (f / maxFreq) * width;
    ctx.strokeStyle = "#e8e8ec";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(f / 1000 + " kHz", x + 3, height - 6);
  }

  // Level axis (y), labelled in dBFS.
  ctx.fillStyle = "#7a7a7d";
  for (const d of [0, -25, -50, -75]) {
    const y = toY(d);
    ctx.fillText(d + " dBFS", 6, d === 0 ? y + 12 : y - 3);
  }

  ctx.strokeStyle = PLOT.trace;
  ctx.lineWidth = 1.6;
  ctx.beginPath();

  let started = false;
  for (let i = 0; i < spectrum.magnitudes.length; i++) {
    const freq = spectrum.frequencies[i];
    if (freq > maxFreq) break;

    let y = toY(spectrum.magnitudes[i]);
    if (y < 0) y = 0;
    if (y > height) y = height;

    const x = (freq / maxFreq) * width;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
}
