// Runs BEFORE every legacy script in public/legacy/.
//
// During the migration the app lives in two worlds: ES modules under src/, and
// classic scripts sharing one global scope under public/legacy/. This file is
// the seam. As each legacy file is converted it moves to src/ and re-exports
// its symbols here, which publishes them on `globalThis` so the not-yet-
// converted files keep finding them exactly where they always were.
//
// Ordering is what makes this work: module scripts and deferred classic scripts
// both run after parsing, in document order. This tag is placed first in
// index.html so every symbol is installed before any legacy code executes —
// which matters because some legacy files read globals at load time, not just
// inside functions.
//
// This file shrinks with every conversion and is deleted once public/legacy/
// is empty.

import { showTab } from "./ui/tabs";
import { ctx2d, el } from "./ui/dom";
import { extractVoiceFeatures, formatFeatures } from "./core/features";
import { createZip } from "./core/zip";
import { PROTOCOL_TESTS, getProtocolTest } from "./core/protocol";
import { analysis, capture, device, library, ui } from "./core/state";
import {
  resetNoiseAttenuator,
  processNoiseAttenuator,
  applyFilterOffline,
} from "./core/dsp/noiseFilter";
import { toggleNoiseAttenuator } from "./rnd/noiseToggle";

// `noiseAttenuatorEnabled` is state, not a function, and app.js/audio.js/
// computerMic.js both read AND write it. An accessor keeps the single source of
// truth in state.ts while legacy assignments still work.
//
// This only functions because the `let noiseAttenuatorEnabled` was deleted from
// app.js in the same commit: a top-level `let` is a global *lexical* binding,
// and it would shadow this property entirely — legacy code would keep using its
// own copy and the two would silently drift apart.
// Each entry pairs a legacy global name with the state field that now owns it.
// The matching `let` must be gone from app.js, or it shadows the accessor.
function alias<T extends object>(name: string, holder: T, key: keyof T): void {
  Object.defineProperty(globalThis, name, {
    get: () => holder[key],
    set: (v) => { holder[key] = v as T[keyof T]; },
    configurable: true,
  });
}

alias("noiseAttenuatorEnabled", capture, "noiseFilterEnabled");
alias("isRecording", capture, "recording");
alias("audioMode", capture, "channelMode");
alias("currentChunks", capture, "chunks");
alias("currentFrameCount", capture, "frames");
alias("currentValueCount", capture, "values");
alias("liveSamples", capture, "live");
alias("recordingWarmupFrames", capture, "warmupFrames");
alias("inputSource", device, "sourceId");
alias("memsConnectionType", device, "transport");
alias("isConnected", device, "connected");
alias("byteBuffer", device, "byteBuffer");
alias("recordings", library, "recordings");
alias("recordingIndex", library, "nextIndex");
alias("appMode", ui, "mode");
alias("lastSpectrum", analysis, "lastSpectrum");
alias("lastSpectrumSourceName", analysis, "lastSpectrumSourceName");
alias("analysisSelectionStart", analysis, "selectionStart");
alias("analysisSelectionEnd", analysis, "selectionEnd");
alias("analysisDragMode", analysis, "dragMode");
alias("calibratedNoiseFloorDb", analysis, "calibratedNoiseFloorDb");


// The ~45 element references app.js used to capture at load time. Installed as
// lazy getters so nothing is resolved before the DOM is ready and so a page
// without a given element simply reports null instead of throwing on load.
const LEGACY_ELEMENTS: Record<string, string> = {
  connectBtn: "connectBtn",
  startBtn: "startBtn",
  stopBtn: "stopBtn",
  calibrateNoiseBtn: "calibrateNoiseBtn",
  plotSpectrumBtn: "plotSpectrumBtn",
  resetZoomBtn: "resetZoomBtn",
  downloadFftBtn: "downloadFftBtn",
  modeSelector: "modeSelector",
  analysisWaveformCanvas: "analysisWaveformCanvas",
  selectedRangeLabel: "selectedRangeLabel",
  connectWifiBtn: "connectWifiBtn",
  statusDiv: "status",
  statusDot: "statusDot",
  durationBox: "durationBox",
  sampleBox: "sampleBox",
  recordingStateBox: "recordingStateBox",
  rmsDbEl: "rmsDb",
  peakDbEl: "peakDb",
  clipPercentEl: "clipPercent",
  hum60El: "hum60",
  hum120El: "hum120",
  noiseFloorEl: "noiseFloor",
  noiseCommentEl: "noiseComment",
  noiseAttenuatorBtn: "noiseAttenuatorBtn",
  rmsBar: "rmsBar",
  peakBar: "peakBar",
  clipBar: "clipBar",
  hum60Bar: "hum60Bar",
  hum120Bar: "hum120Bar",
  spectrumCanvas: "spectrumCanvas",
  dominantFrequenciesEl: "dominantFrequencies",
  fftInterpretationEl: "fftInterpretation",
  fftRangeLabel: "fftRangeLabel",
  fftMinFreqInput: "fftMinFreqInput",
  fftMaxFreqInput: "fftMaxFreqInput",
  analysisSourceSelect: "analysisSourceSelect",
  recordingList: "recordingList",
  recordingCount: "recordingCount",
  logDiv: "log",
  canvas: "waveform",
  liveSpectrumCanvas: "liveSpectrum",
  liveSpectrogramCanvas: "liveSpectrogram",
  analysisSpectrogramCanvas: "analysisSpectrogram",
};

// Canvas contexts, keyed by the canvas element id they derive from.
const LEGACY_CONTEXTS: Record<string, string> = {
  analysisWaveformCtx: "analysisWaveformCanvas",
  spectrumCtx: "spectrumCanvas",
  ctx: "waveform",
  liveSpectrumCtx: "liveSpectrum",
  liveSpectrogramCtx: "liveSpectrogram",
  analysisSpectrogramCtx: "analysisSpectrogram",
};

for (const [name, id] of Object.entries(LEGACY_ELEMENTS)) {
  Object.defineProperty(globalThis, name, { get: () => el(id), configurable: true });
}
for (const [name, canvasId] of Object.entries(LEGACY_CONTEXTS)) {
  Object.defineProperty(globalThis, name, { get: () => ctx2d(canvasId), configurable: true });
}

Object.assign(globalThis, {
  // audio.js -> analyzeRecording() jumps to the analyse view.
  showTab,
  // audio.js stamps features onto a take; clinical.js renders them in the chart.
  extractVoiceFeatures,
  formatFeatures,
  // clinical.js -> exportRecordingsZip() packs a session as one download.
  createZip,
  // clinical.js drives the exam from the test list and looks tests up by id.
  PROTOCOL_TESTS,
  getProtocolTest,
  // app.js resets the chain per take; audio.js and computerMic.js run samples
  // through it on the way into the buffer.
  resetNoiseAttenuator,
  processNoiseAttenuator,
  applyFilterOffline,
  toggleNoiseAttenuator,
});
