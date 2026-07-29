// The Analyze view's waveform: which audio is being analysed, which region of
// it is selected, and the drag interaction that moves that region.
//
// Everything downstream — the FFT, the static spectrogram, the CSV export —
// works on whatever this module says is selected. It announces changes on the
// bus instead of calling the FFT panel, so the waveform stays usable on its
// own; fftView.ts is what subscribes.

import { SAMPLE_RATE } from "../core/constants";
import { analysis, capture, library } from "../core/state";
import { clamp } from "../core/dsp/levels";
import { emit } from "../core/bus";
import { ctx2d, el } from "../ui/dom";
import { PLOT } from "../ui/theme";

/** The full audio behind the Analyze view, before the selection is applied. */
export interface AnalysisSource {
  /** Used in exported filenames, so it has to identify the take. */
  name: string;
  samples: Int16Array;
}

/** The selected region, plus what it was cut from. */
export interface AnalysisSelection extends AnalysisSource {
  fullSamples: Int16Array;
  startIndex: number;
  endIndex: number;
}

/** How close to a handle a click counts as grabbing it, as a fraction. */
const HANDLE_TOLERANCE = 0.025;

/** Shortest selection the FFT can use, in samples. */
const MIN_SELECTION_SAMPLES = 512;

/** Where in the selection the pointer grabbed it, for a "middle" drag. */
let dragOffset = 0;

const waveformCanvas = (): HTMLCanvasElement | null =>
  el<HTMLCanvasElement>("analysisWaveformCanvas");
const waveformCtx = (): CanvasRenderingContext2D | null => ctx2d("analysisWaveformCanvas");

/** The audio the source dropdown currently points at, or null. */
export function getFullAnalysisSource(): AnalysisSource | null {
  const select = el<HTMLSelectElement>("analysisSourceSelect");
  if (!select) return null;

  const sourceValue = select.value;

  if (sourceValue === "live") {
    return { name: "live_buffer", samples: Int16Array.from(capture.live) };
  }

  const recordingId = Number(sourceValue.replace("recording-", ""));
  const recording = library.recordings.find(r => r.id === recordingId);
  if (!recording) return null;

  return {
    name: "recording_" + recording.number + "_" + recording.mode,
    samples: recording.analysisSamples,
  };
}

/** The selected slice of the current source, or null when there is nothing. */
export function getAnalysisSamples(): AnalysisSelection | null {
  const source = getFullAnalysisSource();
  if (!source || source.samples.length < 2) return null;

  const total = source.samples.length;

  let startIndex = Math.floor(analysis.selectionStart * total);
  let endIndex = Math.floor(analysis.selectionEnd * total);

  startIndex = clamp(startIndex, 0, total - 1);
  endIndex = clamp(endIndex, startIndex + 1, total);

  return {
    name: source.name + "_selected_" + startIndex + "_" + endIndex,
    samples: source.samples.slice(startIndex, endIndex),
    fullSamples: source.samples,
    startIndex,
    endIndex,
  };
}

/** Select the whole source again. Used when the source itself changes. */
export function resetAnalysisSelection(): void {
  analysis.selectionStart = 0;
  analysis.selectionEnd = 1;
  analysis.dragMode = null;
  drawAnalysisWaveform();
}

// ---- drawing -------------------------------------------------------------

export function drawAnalysisWaveform(): void {
  const canvas = waveformCanvas();
  const ctx = waveformCtx();
  if (!canvas || !ctx) return;

  const source = getFullAnalysisSource();

  ctx.fillStyle = PLOT.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = PLOT.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (canvas.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  const midY = canvas.height / 2;

  ctx.strokeStyle = PLOT.axis;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(canvas.width, midY);
  ctx.stroke();

  if (!source || source.samples.length < 2) {
    const label = el("selectedRangeLabel");
    if (label) label.textContent = "No waveform available";
    return;
  }

  const samples = source.samples;
  const width = canvas.width;
  const height = canvas.height;

  ctx.strokeStyle = PLOT.trace;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  // One vertical line per pixel column, spanning that column's min and max.
  // Drawing every sample would be both slower and less honest at this scale:
  // a transient narrower than a pixel has to stay visible.
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

    // Empty column (more pixels than samples): draw it flat, not full height.
    if (min === 32767 && max === -32768) {
      min = 0;
      max = 0;
    }

    ctx.moveTo(x, midY - (min / 32768) * height * 0.42);
    ctx.lineTo(x, midY - (max / 32768) * height * 0.42);
  }

  ctx.stroke();

  drawSelectionOverlay(source.samples.length);
}

function drawSelectionOverlay(totalSamples: number): void {
  const canvas = waveformCanvas();
  const ctx = waveformCtx();
  if (!canvas || !ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  const x1 = analysis.selectionStart * width;
  const x2 = analysis.selectionEnd * width;

  ctx.fillStyle = PLOT.selection;
  ctx.fillRect(x1, 0, x2 - x1, height);

  // Dim what is excluded, so the selection reads as the subject.
  ctx.fillStyle = PLOT.excluded;
  ctx.fillRect(0, 0, x1, height);
  ctx.fillRect(x2, 0, width - x2, height);

  // The bounds and their handles are the accent, not an axis label: they are
  // the one thing on this canvas the user is directly manipulating.
  ctx.strokeStyle = PLOT.selectionEdge;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(x1, 0);
  ctx.lineTo(x1, height);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, 0);
  ctx.lineTo(x2, height);
  ctx.stroke();

  // The grab handles.
  ctx.fillStyle = PLOT.selectionEdge;
  ctx.fillRect(x1 - 5, height / 2 - 22, 10, 44);
  ctx.fillRect(x2 - 5, height / 2 - 22, 10, 44);

  const startSec = (analysis.selectionStart * totalSamples) / SAMPLE_RATE;
  const endSec = (analysis.selectionEnd * totalSamples) / SAMPLE_RATE;

  const label = el("selectedRangeLabel");
  if (label) {
    label.textContent = startSec.toFixed(2) + "–" + endSec.toFixed(2) +
      " s · " + (endSec - startSec).toFixed(2) + " s selected";
  }
}

// ---- dragging ------------------------------------------------------------

/** Anything with a clientX: a MouseEvent or one entry of a TouchList. */
interface PointerLike {
  clientX: number;
}

function positionFromPointer(event: PointerLike): number {
  const canvas = waveformCanvas();
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect();
  return clamp((event.clientX - rect.left) / rect.width, 0, 1);
}

function currentSampleCount(): number {
  const source = getFullAnalysisSource();
  // One second is a harmless divisor when there is no audio yet; it only sets
  // the minimum drag width, which is meaningless without a waveform anyway.
  return source ? source.samples.length : SAMPLE_RATE;
}

function beginDrag(event: PointerLike): void {
  const pos = positionFromPointer(event);

  const leftDistance = Math.abs(pos - analysis.selectionStart);
  const rightDistance = Math.abs(pos - analysis.selectionEnd);

  if (leftDistance < HANDLE_TOLERANCE) {
    analysis.dragMode = "left";
  } else if (rightDistance < HANDLE_TOLERANCE) {
    analysis.dragMode = "right";
  } else if (pos > analysis.selectionStart && pos < analysis.selectionEnd) {
    analysis.dragMode = "middle";
    dragOffset = pos - analysis.selectionStart;
  } else {
    // Clicked outside: jump the whole selection here, keeping its width, and
    // continue as a move so the same gesture can keep dragging.
    const width = analysis.selectionEnd - analysis.selectionStart;

    analysis.selectionStart = clamp(pos, 0, 1 - width);
    analysis.selectionEnd = analysis.selectionStart + width;

    analysis.dragMode = "middle";
    dragOffset = pos - analysis.selectionStart;

    drawAnalysisWaveform();
    emit("analysis:selection-changed", undefined);
  }
}

function moveDrag(event: PointerLike): void {
  if (!analysis.dragMode) return;

  const pos = positionFromPointer(event);
  const minWidth = MIN_SELECTION_SAMPLES / currentSampleCount();

  if (analysis.dragMode === "left") {
    analysis.selectionStart = clamp(pos, 0, analysis.selectionEnd - minWidth);
  }

  if (analysis.dragMode === "right") {
    analysis.selectionEnd = clamp(pos, analysis.selectionStart + minWidth, 1);
  }

  if (analysis.dragMode === "middle") {
    const width = analysis.selectionEnd - analysis.selectionStart;
    const newStart = clamp(pos - dragOffset, 0, 1 - width);

    analysis.selectionStart = newStart;
    analysis.selectionEnd = newStart + width;
  }

  drawAnalysisWaveform();
  emit("analysis:selection-changed", undefined);
}

function endDrag(): void {
  analysis.dragMode = null;
}

export function initAnalysisWaveformSelection(): void {
  const canvas = waveformCanvas();
  if (!canvas) return;

  canvas.addEventListener("mousedown", event => beginDrag(event));
  // On window, not the canvas: a drag that leaves the canvas must keep
  // tracking, and releasing outside it must still end the drag.
  window.addEventListener("mousemove", event => moveDrag(event));
  window.addEventListener("mouseup", endDrag);

  canvas.addEventListener("touchstart", event => {
    const touch = event.touches[0];
    if (touch) beginDrag(touch);
  });
  window.addEventListener("touchmove", event => {
    const touch = event.touches[0];
    if (touch) moveDrag(touch);
  });
  window.addEventListener("touchend", endDrag);
}
