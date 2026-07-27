// The R&D Library tab: saved takes as cards, plus the analyse-source picker.
//
// R&D only, by design — a take with exam metadata belongs to the patient chart
// on the clinical side and is filtered out here. Lives under rnd/ because this
// whole view is the mic test bench, not the clinical product.

import { library, type Recording } from "../core/state";
import { capture } from "../core/state";
import { formatFeatures } from "../core/features";
import { deleteRecording as removeFromStorage, saveRecording } from "../storage/library";
import { recordingBaseName, triggerDownload } from "../ui/download";
import { el, requireEl } from "../ui/dom";
import { showTab } from "../ui/tabs";
import { on } from "../core/bus";
import { resetAnalysisSelection } from "./analysisSelection";
import { plotNoiseSpectrum } from "./fftView";
import { log } from "../ui/log";

export function setAudioMode(mode: "stereo" | "left" | "right"): void {
  if (capture.recording) {
    log("Cannot change mic mode while recording.");
    return;
  }

  capture.channelMode = mode;

  document.querySelectorAll<HTMLElement>(".modeBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["mode"] === mode);
  });

  updateCurrentStats();
  log("Mode selected: " + mode + ".");
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

function describe(recording: Recording): string {
  let text =
    recording.duration.toFixed(2) + " s · " +
    recording.source + " · " +
    recording.mode + " · " +
    recording.channels + " channel(s) · " +
    asDate(recording.createdAt).toLocaleTimeString();

  if (recording.meta && recording.meta.patientId) {
    text = recording.meta.patientId + " · " + recording.meta.testName + " · " + text;
  }
  if (recording.filtered) {
    text = "🧹 filtered · " + text;
  }
  return text;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "smallBtn " + className;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

export function renderRecordings(): void {
  const list = el("recordingList");
  const count = el("recordingCount");
  if (!list || !count) return;

  list.innerHTML = "";

  // Clinical takes (meta set) live in the patient chart, not here.
  const rndTakes = library.recordings.filter(r => !r.meta);
  count.textContent = rndTakes.length + " saved";

  if (rndTakes.length === 0) {
    list.innerHTML = '<div class="empty">No recordings yet.</div>';
    return;
  }

  for (const recording of rndTakes) {
    const card = document.createElement("div");
    card.className = "recordingCard";

    const title = document.createElement("div");
    title.className = "recordingTitle";
    title.textContent = recording.name || "Recording " + recording.number;

    const info = document.createElement("div");
    info.className = "recordingInfo";
    info.textContent = describe(recording);

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = recording.url;

    card.append(title, info, audio);

    if (recording.features) {
      const feat = document.createElement("div");
      feat.className = "featureLine";
      feat.textContent = "🧬 " + formatFeatures(recording.features);
      card.appendChild(feat);
    }

    const buttons = document.createElement("div");
    buttons.className = "cardButtons";
    buttons.append(
      button("Analyze FFT", "analyzeBtn", () => analyzeRecording(recording.id)),
      button("Rename", "", () => renameRecording(recording.id)),
      button("Download WAV", "downloadBtn", () => downloadRecording(recording)),
      button("Delete", "deleteBtn", () => deleteRecording(recording.id)),
    );
    card.appendChild(buttons);

    list.appendChild(card);
  }
}

export function updateAnalysisSourceSelect(): void {
  const select = el<HTMLSelectElement>("analysisSourceSelect");
  if (!select) return;

  const previous = select.value;
  select.innerHTML = '<option value="live">Live buffer</option>';

  // Every take is selectable here, clinical included: the analyse view is a
  // diagnostic tool and should be able to look at any signal.
  for (const recording of library.recordings) {
    const option = document.createElement("option");
    option.value = "recording-" + recording.id;

    let label: string;
    if (recording.name) {
      label = recording.name;
    } else if (recording.meta && recording.meta.patientId) {
      label = recording.meta.patientId + " · " + recording.meta.testName;
    } else {
      label = "Recording " + recording.number + " · " + recording.source + " · " + recording.mode;
    }
    option.textContent = label + " · " + recording.duration.toFixed(2) + " s";

    select.appendChild(option);
  }

  // Keep the current selection if that take still exists.
  if (Array.from(select.options).some(o => o.value === previous)) {
    select.value = previous;
  }

  resetAnalysisSelection();
}

export function analyzeRecording(recordingId: number): void {
  requireEl<HTMLSelectElement>("analysisSourceSelect").value = "recording-" + recordingId;
  resetAnalysisSelection();
  showTab("analyzeView");
  plotNoiseSpectrum();
}

export function downloadRecording(recording: Recording): void {
  triggerDownload(recording.url, recordingBaseName(recording) + ".wav");
  log("Recording " + recording.number + " downloaded.");
}

export function renameRecording(id: number): void {
  const target = library.recordings.find(r => r.id === id);
  if (!target) return;

  const current = target.name || "Recording " + target.number;
  const next = prompt("Rename recording:", current);
  if (next === null) return;

  target.name = next.trim() || undefined;

  renderRecordings();
  updateAnalysisSourceSelect();
  renderChart();
  void saveRecording(target);

  log("Recording renamed to: " + (target.name || "Recording " + target.number));
}

export function deleteRecording(id: number): void {
  const target = library.recordings.find(r => r.id === id);
  if (target) {
    // Release the object URL, or the blob stays alive for the page's lifetime.
    URL.revokeObjectURL(target.url);
  }

  library.recordings = library.recordings.filter(r => r.id !== id);

  if (library.recordings.length === 0) {
    const start = el<HTMLButtonElement>("startBtn");
    if (start) start.textContent = "Start";
  }

  void removeFromStorage(id);

  renderRecordings();
  updateAnalysisSourceSelect();

  log("Recording deleted.");
}

// Refresh whenever anything changes the library, wherever it came from: a take
// finishing, a restore from storage, a wipe. Subscribing here keeps core/ and
// storage/ free of any reference to this view.
on("library:changed", () => {
  renderRecordings();
  updateAnalysisSourceSelect();
});
