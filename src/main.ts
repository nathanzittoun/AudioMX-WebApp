// Runs AFTER every legacy script — the application entry point.
//
// The counterpart to bridge.ts: where that one feeds converted code down into
// the legacy world, this one is the top of the app, and the migration pulls
// code down into it from above. This is the former public/legacy/main.js,
// unchanged in behaviour: wire every control, then draw the initial state.
//
// Everything happens inside boot(), on DOMContentLoaded, and that is load
// bearing. In dev this module sits after the legacy <script defer> tags, so
// running at evaluation time would work — but the build bundles bridge.ts and
// this file into one chunk and injects it in <head>, ahead of the legacy
// scripts. Evaluating there threw "stopRecording is not defined" and abandoned
// the rest of the wiring: the production site loaded a dead page while dev
// looked perfect. DOMContentLoaded is the one moment guaranteed to be after
// every deferred classic script in both layouts.

// Installs window.audiomx. Imported for the side effect, first, so it is
// available even if something below throws during boot.
import "./devtools";

import { showTab } from "./ui/tabs";
import { reflectDeviceSupport, watchWifiUrl } from "./device/reflectSupport";
import { connectSerial, initSerial } from "./device/serialSource";
import { connectWifiMems } from "./device/wifiSource";
import { initEhr } from "./ehr/ehrPanel";
import { clearAllData, restoreRecordings } from "./storage/library";
import { renderRecordings, setAudioMode, updateAnalysisSourceSelect } from "./rnd/libraryView";
import { clearLiveSpectrogram } from "./ui/canvas/spectrogram";
import { calibrateNoiseFloor } from "./rnd/meters";
import { drawLiveSpectrum } from "./rnd/liveSpectrum";
import {
  drawAnalysisWaveform, initAnalysisWaveformSelection, resetAnalysisSelection,
} from "./rnd/analysisSelection";
import {
  downloadFftCsv, drawSpectrumBackground, plotNoiseSpectrum, resetFftZoom,
} from "./rnd/fftView";
import {
  clearCanvas, setAppMode, setInputSource, setStatus, startRecording,
  stopRecording, updateCurrentStats,
} from "./app";
import { initClinical } from "./clinical";

function boot(): void {
  // ---- navigation ----

  document.querySelectorAll<HTMLElement>(".tabBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset["tab"];
      if (tab) showTab(tab);
    });
  });

  document.querySelectorAll<HTMLElement>(".modeSwitchBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset["mode"];
      if (mode === "rnd" || mode === "clinical") setAppMode(mode);
    });
  });

  // ---- device + capture ----

  connectBtn.addEventListener("click", connectSerial);
  connectWifiBtn.addEventListener("click", connectWifiMems);
  // Wrapped: a bare reference would hand the click Event to startRecording()
  // as the take metadata.
  startBtn.addEventListener("click", () => void startRecording());
  stopBtn.addEventListener("click", stopRecording);
  calibrateNoiseBtn.addEventListener("click", calibrateNoiseFloor);
  noiseAttenuatorBtn.addEventListener("click", toggleNoiseAttenuator);

  document.querySelectorAll<HTMLElement>(".sourceBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const source = btn.dataset["source"];
      if (source === "mems" || source === "computer") await setInputSource(source);
    });
  });

  document.querySelectorAll<HTMLElement>(".modeBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset["mode"];
      if (mode === "stereo" || mode === "left" || mode === "right") setAudioMode(mode);
    });
  });

  // ---- analysis ----

  plotSpectrumBtn.addEventListener("click", plotNoiseSpectrum);
  resetZoomBtn.addEventListener("click", resetFftZoom);
  downloadFftBtn.addEventListener("click", downloadFftCsv);

  fftMinFreqInput.addEventListener("change", plotNoiseSpectrum);
  fftMaxFreqInput.addEventListener("change", plotNoiseSpectrum);

  analysisSourceSelect.addEventListener("change", () => {
    resetAnalysisSelection();
    plotNoiseSpectrum();
  });

  document.querySelectorAll<HTMLElement>(".zoomPresetBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      fftMinFreqInput.value = btn.dataset["min"] ?? "";
      fftMaxFreqInput.value = btn.dataset["max"] ?? "";
      plotNoiseSpectrum();
    });
  });

  // ---- data ----

  document.getElementById("clearAllBtn")?.addEventListener("click", () => {
    // Asking belongs to the control, not to the storage layer.
    if (confirm("Delete ALL patients and ALL recordings from this browser? This cannot be undone.")) {
      void clearAllData();
    }
  });

  // ---- initial paint ----

  clearCanvas();
  drawLiveSpectrum();
  clearLiveSpectrogram();
  drawSpectrumBackground();
  initAnalysisWaveformSelection();
  drawAnalysisWaveform();
  updateCurrentStats();
  renderRecordings();
  updateAnalysisSourceSelect();
  setStatus("Not connected", "idle");

  // Mark unusable inputs before the clinician can reach for them.
  reflectDeviceSupport();
  watchWifiUrl();
  // Was a load-time side effect of serial.js; an explicit step now.
  initSerial();

  initClinical();
  void initEhr();
  setAppMode("rnd");

  // Restore recordings persisted in this browser from earlier sessions.
  void restoreRecordings();
}

// The test is "complete", not "loading". A module script is deferred, and the
// parser sets readyState to "interactive" *before* running deferred scripts —
// so at this point it already reads "interactive" and a !== "loading" guard
// would call boot() straight away, which is the very thing this avoids.
// DOMContentLoaded has not fired yet in either "loading" or "interactive".
if (document.readyState === "complete") {
  boot();
} else {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
}
