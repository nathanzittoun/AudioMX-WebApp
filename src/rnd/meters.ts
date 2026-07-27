// The Record page's signal-quality meters: level, peak, clipping, mains hum,
// and the calibrated noise floor they are read against.
//
// This is the panel that tells Nathan whether a microphone build is good — the
// R&D bench in one screen. It reads a rolling window of raw samples and writes
// numbers and bar widths; all of the maths is in core/dsp/levels.

import { SAMPLE_RATE } from "../core/constants";
import { analysis, capture } from "../core/state";
import { clamp, dbfs, dbToBar, goertzelMagnitude } from "../core/dsp/levels";
import { el } from "../ui/dom";
import { log } from "../ui/log";

/** Sample value above which a 16-bit sample counts as clipped. */
const CLIP_THRESHOLD = 32000;

/** Mains frequency and its first harmonic — the signature of electrical hum. */
const HUM_60 = 60;
const HUM_120 = 120;

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

function setBar(id: string, percent: number): void {
  const node = el(id);
  if (node) node.style.width = percent + "%";
}

/**
 * Refresh every meter from the live window. Called on each render tick during a
 * capture, so it walks the samples exactly once for RMS, peak and clipping.
 */
export function updateNoiseIndicators(samples: ArrayLike<number> | null): void {
  if (!samples || samples.length === 0) return;

  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const absS = Math.abs(s);

    sumSquares += s * s;
    if (absS > peak) peak = absS;
    if (absS > CLIP_THRESHOLD) clipped++;
  }

  const rmsDb = dbfs(Math.sqrt(sumSquares / samples.length));
  const peakDb = dbfs(peak);
  const clippingPercent = (clipped / samples.length) * 100;

  // Goertzel rather than a full FFT: two known frequencies, two loops.
  const hum60Db = dbfs(goertzelMagnitude(samples, HUM_60, SAMPLE_RATE));
  const hum120Db = dbfs(goertzelMagnitude(samples, HUM_120, SAMPLE_RATE));

  setText("rmsDb", rmsDb.toFixed(1) + " dBFS");
  setText("peakDb", peakDb.toFixed(1) + " dBFS");
  setText("clipPercent", clippingPercent.toFixed(2) + "%");
  setText("hum60", hum60Db.toFixed(1) + " dB");
  setText("hum120", hum120Db.toFixed(1) + " dB");

  setBar("rmsBar", dbToBar(rmsDb));
  setBar("peakBar", dbToBar(peakDb));
  // x20 so the bar is readable: half a percent of clipping already matters.
  setBar("clipBar", clamp(clippingPercent * 20, 0, 100));
  setBar("hum60Bar", dbToBar(hum60Db));
  setBar("hum120Bar", dbToBar(hum120Db));

  const floor = analysis.calibratedNoiseFloorDb;
  if (floor !== null) {
    const aboveNoise = rmsDb - floor;
    setText("noiseFloor", floor.toFixed(1) + " dBFS baseline");

    if (aboveNoise < 3) {
      setText("noiseComment", "Current input is near the calibrated noise floor.");
    } else if (aboveNoise < 10) {
      setText("noiseComment", "Current input is slightly above the noise floor.");
    } else {
      setText("noiseComment", "Current input is clearly above the noise floor.");
    }
  }

  // Deliberately last: a real fault overwrites the noise-floor commentary,
  // because it is the thing the operator has to act on.
  if (clippingPercent > 0.5) {
    setText("noiseComment", "Clipping detected. Increase PCM_SHIFT in Arduino code to reduce gain.");
  } else if (hum60Db > -35 || hum120Db > -35) {
    setText("noiseComment", "Strong 60/120 Hz component detected. Possible electrical hum or power noise.");
  }
}

/**
 * Take the current live window as the room's baseline. Everything the meters
 * say afterwards is relative to it, so it has to be recorded on silence.
 */
export function calibrateNoiseFloor(): void {
  const live = capture.live;

  if (live.length < SAMPLE_RATE * 0.5) {
    setText("noiseFloor", "Need more silence");
    setText("noiseComment", "Record at least 1 second of quiet audio, then calibrate.");
    return;
  }

  let sumSquares = 0;
  for (let i = 0; i < live.length; i++) sumSquares += live[i] * live[i];

  const floor = dbfs(Math.sqrt(sumSquares / live.length));
  analysis.calibratedNoiseFloorDb = floor;

  setText("noiseFloor", floor.toFixed(1) + " dBFS baseline");
  setText("noiseComment", "Noise floor calibrated. Now compare speech or silence against it.");

  log("Noise floor calibrated: " + floor.toFixed(1) + " dBFS");
}
