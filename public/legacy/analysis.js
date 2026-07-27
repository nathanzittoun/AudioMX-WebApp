// Analysis view rendering: canvases, meters, the waveform selection and the
// FFT/spectrogram panels. The pure DSP this builds on now lives in
// src/core/dsp/ (levels, fft, spectrum) and is published by bridge.ts.

function drawSpectrumBackground(minFreq = 0, maxFreq = SAMPLE_RATE / 2) {
  spectrumCtx.fillStyle = "#f0f0f2";
  spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);

  spectrumCtx.strokeStyle = "#d8d8dc";
  spectrumCtx.lineWidth = 1;

  for (let i = 0; i <= 5; i++) {
    const y = (spectrumCanvas.height / 5) * i;

    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, y);
    spectrumCtx.lineTo(spectrumCanvas.width, y);
    spectrumCtx.stroke();

    const db = 0 - i * 20;
    spectrumCtx.fillStyle = "#7a7a7d";
    spectrumCtx.font = "12px -apple-system, BlinkMacSystemFont, Arial";
    spectrumCtx.fillText(db + " dB", 8, y + 14);
  }

  for (let i = 0; i <= 8; i++) {
    const x = (spectrumCanvas.width / 8) * i;
    const freq = Math.round(minFreq + (maxFreq - minFreq) * (i / 8));

    spectrumCtx.beginPath();
    spectrumCtx.moveTo(x, 0);
    spectrumCtx.lineTo(x, spectrumCanvas.height);
    spectrumCtx.stroke();

    spectrumCtx.fillStyle = "#7a7a7d";
    spectrumCtx.font = "12px -apple-system, BlinkMacSystemFont, Arial";
    spectrumCtx.fillText(freq + " Hz", x + 6, spectrumCanvas.height - 10);
  }
}

function getFullAnalysisSource() {
  const sourceValue = analysisSourceSelect.value;

  if (sourceValue === "live") {
    return {
      name: "live_buffer",
      samples: Int16Array.from(liveSamples)
    };
  }

  const recordingId = Number(sourceValue.replace("recording-", ""));
  const recording = recordings.find(r => r.id === recordingId);

  if (!recording) {
    return null;
  }

  return {
    name: "recording_" + recording.number + "_" + recording.mode,
    samples: recording.analysisSamples
  };
}

function getSelectedAnalysisSamples() {
  const source = getFullAnalysisSource();

  if (!source || source.samples.length < 2) {
    return null;
  }

  const total = source.samples.length;

  let startIndex = Math.floor(analysisSelectionStart * total);
  let endIndex = Math.floor(analysisSelectionEnd * total);

  startIndex = clamp(startIndex, 0, total - 1);
  endIndex = clamp(endIndex, startIndex + 1, total);

  const selected = source.samples.slice(startIndex, endIndex);

  return {
    name: source.name + "_selected_" + startIndex + "_" + endIndex,
    samples: selected,
    fullSamples: source.samples,
    startIndex,
    endIndex
  };
}

function getAnalysisSamples() {
  return getSelectedAnalysisSamples();
}

function resetAnalysisSelection() {
  analysisSelectionStart = 0;
  analysisSelectionEnd = 1;
  analysisDragMode = null;
  drawAnalysisWaveform();
}

function drawAnalysisWaveform() {
  if (!analysisWaveformCanvas || !analysisWaveformCtx) {
    return;
  }

  const source = getFullAnalysisSource();

  analysisWaveformCtx.fillStyle = "#f0f0f2";
  analysisWaveformCtx.fillRect(
    0,
    0,
    analysisWaveformCanvas.width,
    analysisWaveformCanvas.height
  );

  analysisWaveformCtx.strokeStyle = "#d8d8dc";
  analysisWaveformCtx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = (analysisWaveformCanvas.height / 4) * i;
    analysisWaveformCtx.beginPath();
    analysisWaveformCtx.moveTo(0, y);
    analysisWaveformCtx.lineTo(analysisWaveformCanvas.width, y);
    analysisWaveformCtx.stroke();
  }

  const midY = analysisWaveformCanvas.height / 2;

  analysisWaveformCtx.strokeStyle = "#b8b8bd";
  analysisWaveformCtx.beginPath();
  analysisWaveformCtx.moveTo(0, midY);
  analysisWaveformCtx.lineTo(analysisWaveformCanvas.width, midY);
  analysisWaveformCtx.stroke();

  if (!source || source.samples.length < 2) {
    selectedRangeLabel.textContent = "No waveform available";
    return;
  }

  const samples = source.samples;
  const width = analysisWaveformCanvas.width;
  const height = analysisWaveformCanvas.height;

  analysisWaveformCtx.strokeStyle = "#b31b1b";
  analysisWaveformCtx.lineWidth = 1.5;
  analysisWaveformCtx.beginPath();

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

    if (min === 32767 && max === -32768) {
      min = 0;
      max = 0;
    }

    const yMin = midY - (min / 32768) * height * 0.42;
    const yMax = midY - (max / 32768) * height * 0.42;

    analysisWaveformCtx.moveTo(x, yMin);
    analysisWaveformCtx.lineTo(x, yMax);
  }

  analysisWaveformCtx.stroke();

  drawSelectionOverlay(source.samples.length);
}

function drawSelectionOverlay(totalSamples) {
  const width = analysisWaveformCanvas.width;
  const height = analysisWaveformCanvas.height;

  const x1 = analysisSelectionStart * width;
  const x2 = analysisSelectionEnd * width;

  analysisWaveformCtx.fillStyle = "rgba(179, 27, 27, 0.16)";
  analysisWaveformCtx.fillRect(x1, 0, x2 - x1, height);

  analysisWaveformCtx.fillStyle = "rgba(0, 0, 0, 0.10)";
  analysisWaveformCtx.fillRect(0, 0, x1, height);
  analysisWaveformCtx.fillRect(x2, 0, width - x2, height);

  analysisWaveformCtx.strokeStyle = "#1d1d1f";
  analysisWaveformCtx.lineWidth = 3;

  analysisWaveformCtx.beginPath();
  analysisWaveformCtx.moveTo(x1, 0);
  analysisWaveformCtx.lineTo(x1, height);
  analysisWaveformCtx.stroke();

  analysisWaveformCtx.beginPath();
  analysisWaveformCtx.moveTo(x2, 0);
  analysisWaveformCtx.lineTo(x2, height);
  analysisWaveformCtx.stroke();

  analysisWaveformCtx.fillStyle = "#1d1d1f";
  analysisWaveformCtx.fillRect(x1 - 5, height / 2 - 22, 10, 44);
  analysisWaveformCtx.fillRect(x2 - 5, height / 2 - 22, 10, 44);

  const startSec = (analysisSelectionStart * totalSamples) / SAMPLE_RATE;
  const endSec = (analysisSelectionEnd * totalSamples) / SAMPLE_RATE;
  const durationSec = endSec - startSec;

  selectedRangeLabel.textContent =
    startSec.toFixed(2) +
    "–" +
    endSec.toFixed(2) +
    " s · " +
    durationSec.toFixed(2) +
    " s selected";
}

function getAnalysisWaveformMousePosition(event) {
  const rect = analysisWaveformCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  return clamp(x / rect.width, 0, 1);
}

let analysisDragOffset = 0;

function beginAnalysisSelectionDrag(event) {
  const pos = getAnalysisWaveformMousePosition(event);

  const leftDistance = Math.abs(pos - analysisSelectionStart);
  const rightDistance = Math.abs(pos - analysisSelectionEnd);

  const handleTolerance = 0.025;

  if (leftDistance < handleTolerance) {
    analysisDragMode = "left";
  } else if (rightDistance < handleTolerance) {
    analysisDragMode = "right";
  } else if (pos > analysisSelectionStart && pos < analysisSelectionEnd) {
    analysisDragMode = "middle";
    analysisDragOffset = pos - analysisSelectionStart;
  } else {
    const width = analysisSelectionEnd - analysisSelectionStart;

    analysisSelectionStart = clamp(pos, 0, 1 - width);
    analysisSelectionEnd = analysisSelectionStart + width;

    analysisDragMode = "middle";
    analysisDragOffset = pos - analysisSelectionStart;

    drawAnalysisWaveform();
    plotNoiseSpectrum();
  }
}

function moveAnalysisSelectionDrag(event) {
  if (!analysisDragMode) {
    return;
  }

  const pos = getAnalysisWaveformMousePosition(event);
  const minWidth = 512 / getCurrentAnalysisSampleCount();

  if (analysisDragMode === "left") {
    analysisSelectionStart = clamp(pos, 0, analysisSelectionEnd - minWidth);
  }

  if (analysisDragMode === "right") {
    analysisSelectionEnd = clamp(pos, analysisSelectionStart + minWidth, 1);
  }

  if (analysisDragMode === "middle") {
    const width = analysisSelectionEnd - analysisSelectionStart;
    let newStart = pos - analysisDragOffset;

    newStart = clamp(newStart, 0, 1 - width);

    analysisSelectionStart = newStart;
    analysisSelectionEnd = newStart + width;
  }

  drawAnalysisWaveform();
  plotNoiseSpectrum();
}

function endAnalysisSelectionDrag() {
  analysisDragMode = null;
}

function getCurrentAnalysisSampleCount() {
  const source = getFullAnalysisSource();

  if (!source || !source.samples) {
    return SAMPLE_RATE;
  }

  return source.samples.length;
}

function initAnalysisWaveformSelection() {
  if (!analysisWaveformCanvas) {
    return;
  }

  analysisWaveformCanvas.addEventListener("mousedown", event => {
    beginAnalysisSelectionDrag(event);
  });

  window.addEventListener("mousemove", event => {
    moveAnalysisSelectionDrag(event);
  });

  window.addEventListener("mouseup", () => {
    endAnalysisSelectionDrag();
  });

  analysisWaveformCanvas.addEventListener("touchstart", event => {
    if (event.touches.length > 0) {
      beginAnalysisSelectionDrag(event.touches[0]);
    }
  });

  window.addEventListener("touchmove", event => {
    if (event.touches.length > 0) {
      moveAnalysisSelectionDrag(event.touches[0]);
    }
  });

  window.addEventListener("touchend", () => {
    endAnalysisSelectionDrag();
  });
}

function plotNoiseSpectrum() {
  drawAnalysisWaveform();

  const source = getAnalysisSamples();

  if (!source || source.samples.length < 1024) {
    dominantFrequenciesEl.textContent = "Need more samples. Select a larger waveform region.";
    fftInterpretationEl.textContent = "Drag the waveform boundaries to select more audio.";
    return;
  }

  const minFreq = clamp(Number(fftMinFreqInput.value) || 0, 0, SAMPLE_RATE / 2);
  const maxFreq = clamp(
    Number(fftMaxFreqInput.value) || SAMPLE_RATE / 2,
    minFreq + 10,
    SAMPLE_RATE / 2
  );

  fftMinFreqInput.value = Math.round(minFreq);
  fftMaxFreqInput.value = Math.round(maxFreq);
  fftRangeLabel.textContent = Math.round(minFreq) + "–" + Math.round(maxFreq) + " Hz";

  const spectrum = computeSpectrum(source.samples);

  if (!spectrum) {
    dominantFrequenciesEl.textContent = "Not enough data for FFT.";
    fftInterpretationEl.textContent = "Select a larger waveform region.";
    return;
  }

  lastSpectrum = spectrum;
  lastSpectrumSourceName = source.name;

  // Spectrogram of the selected region, alongside the averaged FFT.
  renderStaticSpectrogram(
    analysisSpectrogramCtx,
    analysisSpectrogramCanvas,
    source.samples,
    SAMPLE_RATE
  );

  drawSpectrumBackground(minFreq, maxFreq);

  const minDb = -110;
  const maxDb = 0;

  spectrumCtx.strokeStyle = "#b31b1b";
  spectrumCtx.lineWidth = 2.25;
  spectrumCtx.beginPath();

  let started = false;

  for (let i = 0; i < spectrum.magnitudes.length; i++) {
    const freq = spectrum.frequencies[i];

    if (freq < minFreq || freq > maxFreq) {
      continue;
    }

    const db = spectrum.magnitudes[i];

    const x = ((freq - minFreq) / (maxFreq - minFreq)) * spectrumCanvas.width;
    const y = spectrumCanvas.height - ((db - minDb) / (maxDb - minDb)) * spectrumCanvas.height;
    const yClamped = clamp(y, 0, spectrumCanvas.height);

    if (!started) {
      spectrumCtx.moveTo(x, yClamped);
      started = true;
    } else {
      spectrumCtx.lineTo(x, yClamped);
    }
  }

  spectrumCtx.stroke();

  const peaks = findDominantFrequencies(spectrum, minFreq, maxFreq);

  dominantFrequenciesEl.textContent =
    peaks.length === 0
      ? "No clear peaks in this selected region."
      : peaks
          .map(p => Math.round(p.freq) + " Hz (" + p.db.toFixed(1) + " dB)")
          .join(", ");

  fftInterpretationEl.textContent =
    interpretSpectrum(peaks) +
    " FFT averaged over " +
    spectrum.averagedFrames +
    " frame(s) from the selected waveform region.";

  spectrumCtx.fillStyle = "#1d1d1f";
  spectrumCtx.font = "12px -apple-system, BlinkMacSystemFont, Arial";

  for (const peak of peaks.slice(0, 6)) {
    const x = ((peak.freq - minFreq) / (maxFreq - minFreq)) * spectrumCanvas.width;
    const y = spectrumCanvas.height - ((peak.db - minDb) / (maxDb - minDb)) * spectrumCanvas.height;
    const yClamped = clamp(y, 14, spectrumCanvas.height - 22);

    spectrumCtx.beginPath();
    spectrumCtx.arc(x, yClamped, 4, 0, 2 * Math.PI);
    spectrumCtx.fill();

    spectrumCtx.fillText(
      Math.round(peak.freq) + " Hz",
      clamp(x + 7, 8, spectrumCanvas.width - 70),
      yClamped - 7
    );
  }

  downloadFftBtn.disabled = false;

  log(
    "FFT plotted from " +
      source.name +
      " using " +
      source.samples.length +
      " selected samples."
  );
}

function resetFftZoom() {
  fftMinFreqInput.value = 0;
  fftMaxFreqInput.value = SAMPLE_RATE / 2;
  plotNoiseSpectrum();
}

function downloadFftCsv() {
  if (!lastSpectrum) {
    return;
  }

  let csv = "frequency_hz,magnitude_db\n";

  for (let i = 0; i < lastSpectrum.frequencies.length; i++) {
    csv +=
      lastSpectrum.frequencies[i].toFixed(3) +
      "," +
      lastSpectrum.magnitudes[i].toFixed(6) +
      "\n";
  }

  const blob = new Blob([csv], {
    type: "text/csv"
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  a.href = url;
  a.download = "fft_" + lastSpectrumSourceName + "_" + timestamp + ".csv";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);

  log("FFT CSV downloaded.");
}