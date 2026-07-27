// Runs AFTER every legacy script — the application entry point.
//
// The counterpart to bridge.ts: where that one feeds converted code down into
// the legacy world, this one is the top of the app, and the migration pulls
// code down into it from above. This is the former public/legacy/main.js,
// unchanged in behaviour: wire every control, then draw the initial state.

import { showTab } from "./ui/tabs";
import { reflectDeviceSupport, watchWifiUrl } from "./device/reflectSupport";
import { connectSerial, initSerial } from "./device/serialSource";
import { clearAllData, restoreRecordings } from "./storage/library";
import { renderRecordings, setAudioMode, updateAnalysisSourceSelect } from "./rnd/libraryView";

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
    if (mode) setAppMode(mode);
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
    if (source) await setInputSource(source);
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
initEhr();
setAppMode("rnd");

// Restore recordings persisted in this browser from earlier sessions.
void restoreRecordings();
