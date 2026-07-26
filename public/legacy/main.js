function showTab(tabId) {
  document.querySelectorAll(".view").forEach(view => {
    view.classList.remove("activeView");
  });

  document.getElementById(tabId).classList.add("activeView");

  document.querySelectorAll(".tabBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });

  if (tabId === "analyzeView") {
    drawSpectrumBackground(
      Number(fftMinFreqInput.value) || 0,
      Number(fftMaxFreqInput.value) || SAMPLE_RATE / 2
    );
  }
}

document.querySelectorAll(".tabBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    showTab(btn.dataset.tab);
  });
});

document.querySelectorAll(".modeSwitchBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    setAppMode(btn.dataset.mode);
  });
});

document.getElementById("clearAllBtn").addEventListener("click", clearAllData);

connectBtn.addEventListener("click", connectSerial);
connectWifiBtn.addEventListener("click", connectWifiMems);
startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
calibrateNoiseBtn.addEventListener("click", calibrateNoiseFloor);
noiseAttenuatorBtn.addEventListener("click", toggleNoiseAttenuator);

plotSpectrumBtn.addEventListener("click", plotNoiseSpectrum);
resetZoomBtn.addEventListener("click", resetFftZoom);
downloadFftBtn.addEventListener("click", downloadFftCsv);

fftMinFreqInput.addEventListener("change", plotNoiseSpectrum);
fftMaxFreqInput.addEventListener("change", plotNoiseSpectrum);

analysisSourceSelect.addEventListener("change", () => {
  resetAnalysisSelection();
  plotNoiseSpectrum();
});

document.querySelectorAll(".zoomPresetBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    fftMinFreqInput.value = btn.dataset.min;
    fftMaxFreqInput.value = btn.dataset.max;
    plotNoiseSpectrum();
  });
});

document.querySelectorAll(".sourceBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
        await setInputSource(btn.dataset.source);
    });
});

document.querySelectorAll(".modeBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    setAudioMode(btn.dataset.mode);
  });
});

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

initClinical();
initEhr();
setAppMode("rnd");

// Restore recordings persisted in this browser from earlier sessions.
restoreRecordings();