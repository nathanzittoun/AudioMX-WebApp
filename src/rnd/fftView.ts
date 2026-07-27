// The Analyze view's frequency panel: the averaged FFT plot, the peak
// annotations, the static spectrogram beside it, and the CSV export.
//
// It reads whatever analysisSelection.ts says is selected and subscribes to
// that module's change event, so dragging the waveform replots without the
// waveform knowing this panel exists.

import { SAMPLE_RATE } from "../core/constants";
import { analysis } from "../core/state";
import { clamp } from "../core/dsp/levels";
import { computeSpectrum, findDominantFrequencies, interpretSpectrum } from "../core/dsp/spectrum";
import { on } from "../core/bus";
import { ctx2d, el } from "../ui/dom";
import { renderStaticSpectrogram } from "../ui/canvas/spectrogram";
import { triggerDownload } from "../ui/download";
import { drawAnalysisWaveform, getAnalysisSamples } from "./analysisSelection";
import { log } from "../ui/log";

/** Plot range in dB. Wider than the live strip because takes can be quiet. */
const PLOT_MIN_DB = -110;
const PLOT_MAX_DB = 0;

/** Shortest selection worth transforming, in samples. */
const MIN_FFT_SAMPLES = 1024;

const spectrumCanvas = (): HTMLCanvasElement | null => el<HTMLCanvasElement>("spectrumCanvas");
const spectrumCtx = (): CanvasRenderingContext2D | null => ctx2d("spectrumCanvas");

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

/**
 * Axes and grid for the spectrum plot. Exported because the tab switch redraws
 * an empty panel with them, before any FFT has run.
 */
export function drawSpectrumBackground(minFreq = 0, maxFreq = SAMPLE_RATE / 2): void {
  const canvas = spectrumCanvas();
  const ctx = spectrumCtx();
  if (!canvas || !ctx) return;

  ctx.fillStyle = "#f0f0f2";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#d8d8dc";
  ctx.lineWidth = 1;
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Arial";

  // Level axis, every 20 dB.
  for (let i = 0; i <= 5; i++) {
    const y = (canvas.height / 5) * i;

    ctx.strokeStyle = "#d8d8dc";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();

    ctx.fillStyle = "#7a7a7d";
    ctx.fillText(0 - i * 20 + " dB", 8, y + 14);
  }

  // Frequency axis, eight divisions across whatever range is zoomed to.
  for (let i = 0; i <= 8; i++) {
    const x = (canvas.width / 8) * i;
    const freq = Math.round(minFreq + (maxFreq - minFreq) * (i / 8));

    ctx.strokeStyle = "#d8d8dc";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();

    ctx.fillStyle = "#7a7a7d";
    ctx.fillText(freq + " Hz", x + 6, canvas.height - 10);
  }
}

export function plotNoiseSpectrum(): void {
  drawAnalysisWaveform();

  const source = getAnalysisSamples();

  if (!source || source.samples.length < MIN_FFT_SAMPLES) {
    setText("dominantFrequencies", "Need more samples. Select a larger waveform region.");
    setText("fftInterpretation", "Drag the waveform boundaries to select more audio.");
    return;
  }

  const minInput = el<HTMLInputElement>("fftMinFreqInput");
  const maxInput = el<HTMLInputElement>("fftMaxFreqInput");

  const minFreq = clamp(Number(minInput?.value) || 0, 0, SAMPLE_RATE / 2);
  // At least 10 Hz wide, or the plot divides by zero.
  const maxFreq = clamp(Number(maxInput?.value) || SAMPLE_RATE / 2, minFreq + 10, SAMPLE_RATE / 2);

  // Write the clamped values back, so the inputs show what is actually drawn.
  if (minInput) minInput.value = String(Math.round(minFreq));
  if (maxInput) maxInput.value = String(Math.round(maxFreq));
  setText("fftRangeLabel", Math.round(minFreq) + "–" + Math.round(maxFreq) + " Hz");

  const spectrum = computeSpectrum(source.samples);
  if (!spectrum) {
    setText("dominantFrequencies", "Not enough data for FFT.");
    setText("fftInterpretation", "Select a larger waveform region.");
    return;
  }

  analysis.lastSpectrum = spectrum;
  analysis.lastSpectrumSourceName = source.name;

  // Spectrogram of the selected region, alongside the averaged FFT.
  renderStaticSpectrogram(
    ctx2d("analysisSpectrogram"),
    el<HTMLCanvasElement>("analysisSpectrogram"),
    source.samples,
    SAMPLE_RATE
  );

  drawSpectrumBackground(minFreq, maxFreq);

  const canvas = spectrumCanvas();
  const ctx = spectrumCtx();
  if (!canvas || !ctx) return;

  const toX = (freq: number): number => ((freq - minFreq) / (maxFreq - minFreq)) * canvas.width;
  const toY = (db: number): number =>
    canvas.height - ((db - PLOT_MIN_DB) / (PLOT_MAX_DB - PLOT_MIN_DB)) * canvas.height;

  ctx.strokeStyle = "#b31b1b";
  ctx.lineWidth = 2.25;
  ctx.beginPath();

  let started = false;
  for (let i = 0; i < spectrum.magnitudes.length; i++) {
    const freq = spectrum.frequencies[i];
    if (freq < minFreq || freq > maxFreq) continue;

    const x = toX(freq);
    const y = clamp(toY(spectrum.magnitudes[i]), 0, canvas.height);

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();

  const peaks = findDominantFrequencies(spectrum, minFreq, maxFreq);

  setText("dominantFrequencies", peaks.length === 0
    ? "No clear peaks in this selected region."
    : peaks.map(p => Math.round(p.freq) + " Hz (" + p.db.toFixed(1) + " dB)").join(", "));

  setText("fftInterpretation", interpretSpectrum(peaks) +
    " FFT averaged over " + spectrum.averagedFrames +
    " frame(s) from the selected waveform region.");

  ctx.fillStyle = "#1d1d1f";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Arial";

  for (const peak of peaks.slice(0, 6)) {
    const x = toX(peak.freq);
    // Kept off the edges so the label stays readable at the top of the plot.
    const y = clamp(toY(peak.db), 14, canvas.height - 22);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillText(Math.round(peak.freq) + " Hz", clamp(x + 7, 8, canvas.width - 70), y - 7);
  }

  const downloadBtn = el<HTMLButtonElement>("downloadFftBtn");
  if (downloadBtn) downloadBtn.disabled = false;

  log("FFT plotted from " + source.name + " using " + source.samples.length + " selected samples.");
}

export function resetFftZoom(): void {
  const minInput = el<HTMLInputElement>("fftMinFreqInput");
  const maxInput = el<HTMLInputElement>("fftMaxFreqInput");
  if (minInput) minInput.value = "0";
  if (maxInput) maxInput.value = String(SAMPLE_RATE / 2);
  plotNoiseSpectrum();
}

export function downloadFftCsv(): void {
  const spectrum = analysis.lastSpectrum;
  if (!spectrum) return;

  let csv = "frequency_hz,magnitude_db\n";
  for (let i = 0; i < spectrum.frequencies.length; i++) {
    csv += spectrum.frequencies[i].toFixed(3) + "," + spectrum.magnitudes[i].toFixed(6) + "\n";
  }

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  triggerDownload(url, "fft_" + analysis.lastSpectrumSourceName + "_" + timestamp + ".csv");
  URL.revokeObjectURL(url);

  log("FFT CSV downloaded.");
}

// Dragging the waveform replots the spectrum. Registered on import, once.
on("analysis:selection-changed", plotNoiseSpectrum);
