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
  clearCanvas, setAppMode, setInputSource, startRecording,
  stopRecording,
} from "./app";
import { updateCurrentStats } from "./ui/captureStats";
import { setStatus } from "./ui/status";
import { el, requireEl } from "./ui/dom";
import { toggleNoiseAttenuator } from "./rnd/noiseToggle";
import { initClinical, setClinicalTab } from "./clinical";
import { goto, initNav } from "./ui/nav";
import { registerServiceWorker } from "./pwa";

function boot(): void {
  // ---- navigation ----

  // One bar for the three switching mechanisms. The handlers are injected here
  // rather than imported by nav.ts, because nav.ts is also imported *by* those
  // three modules so the bar follows a navigation made from code — a recording
  // card's Analyze button, a patient row — and importing back would be a cycle.
  initNav({ setAppMode, showTab, setClinicalTab });

  // ---- device + capture ----

  requireEl("connectBtn").addEventListener("click", connectSerial);
  requireEl("connectWifiBtn").addEventListener("click", connectWifiMems);
  // Wrapped: a bare reference would hand the click Event to startRecording()
  // as the take metadata.
  requireEl("startBtn").addEventListener("click", () => void startRecording());
  requireEl("stopBtn").addEventListener("click", () => void stopRecording());
  requireEl("calibrateNoiseBtn").addEventListener("click", calibrateNoiseFloor);
  requireEl("noiseAttenuatorBtn").addEventListener("click", toggleNoiseAttenuator);

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

  const fftMin = requireEl<HTMLInputElement>("fftMinFreqInput");
  const fftMax = requireEl<HTMLInputElement>("fftMaxFreqInput");

  requireEl("plotSpectrumBtn").addEventListener("click", plotNoiseSpectrum);
  requireEl("resetZoomBtn").addEventListener("click", resetFftZoom);
  requireEl("downloadFftBtn").addEventListener("click", downloadFftCsv);

  fftMin.addEventListener("change", plotNoiseSpectrum);
  fftMax.addEventListener("change", plotNoiseSpectrum);

  requireEl("analysisSourceSelect").addEventListener("change", () => {
    resetAnalysisSelection();
    plotNoiseSpectrum();
  });

  document.querySelectorAll<HTMLElement>(".zoomPresetBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      fftMin.value = btn.dataset["min"] ?? "";
      fftMax.value = btn.dataset["max"] ?? "";
      plotNoiseSpectrum();
    });
  });

  // ---- data ----

  el("clearAllBtn")?.addEventListener("click", () => {
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
  // The app opens on Device. The product page is a separate entry point now, so
  // whoever loads this URL has already chosen the tool — and the first thing the
  // tool needs is an input it can actually reach. initClinical leaves the
  // clinical side on its Patients tab, so going there next is one click with
  // nothing half-set.
  goto("device");

  // Restore recordings persisted in this browser from earlier sessions.
  void restoreRecordings();

  // Last: offline caching is the least important thing on this page.
  registerServiceWorker();
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
