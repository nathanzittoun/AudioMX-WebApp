function setAudioMode(mode) {
  if (isRecording) {
    log("Cannot change mic mode while recording.");
    return;
  }

  audioMode = mode;

  document.querySelectorAll(".modeBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  updateCurrentStats();
  log("Mode selected: " + mode + ".");
}

function addSamples(payloadBytes) {
  if (!isRecording) {
    return;
  }

  const view = new DataView(
    payloadBytes.buffer,
    payloadBytes.byteOffset,
    payloadBytes.byteLength
  );

  const frameCount = payloadBytes.byteLength / 4;

  // Skip the USB power-on transient at the very start of a recording.
  if (recordingWarmupFrames > 0) {
    recordingWarmupFrames -= frameCount;
    return;
  }

  let outputSamples;

  if (audioMode === "stereo") {
    outputSamples = new Int16Array(frameCount * 2);
  } else {
    outputSamples = new Int16Array(frameCount);
  }

  for (let i = 0; i < frameCount; i++) {
    const right = view.getInt16(i * 4, true);
    const left = view.getInt16(i * 4 + 2, true);

    if (audioMode === "stereo") {
      outputSamples[i * 2] = right;
      outputSamples[i * 2 + 1] = left;
    } else if (audioMode === "left") {
      outputSamples[i] = left;
    } else if (audioMode === "right") {
      outputSamples[i] = right;
    }
  }

  const channelCount = audioMode === "stereo" ? 2 : 1;

  // If the Noise filter is ON, bake it into the stored audio (one file). If
  // OFF, store the raw capture. Record with it OFF for the raw signal used in
  // biomarker analysis; ON for a cleaned take.
  const stored = noiseAttenuatorEnabled
    ? processNoiseAttenuator(outputSamples, channelCount)
    : outputSamples;

  for (let i = 0; i < frameCount; i++) {
    if (audioMode === "stereo") {
      const right = stored[i * 2];
      const left = stored[i * 2 + 1];
      liveSamples.push(Math.round((right + left) / 2));
    } else {
      liveSamples.push(stored[i]);
    }
  }

  currentChunks.push(stored);
  currentFrameCount += frameCount;
  currentValueCount += stored.length;

  if (liveSamples.length > MAX_LIVE_SAMPLES) {
    liveSamples = liveSamples.slice(liveSamples.length - MAX_LIVE_SAMPLES);
  }

  updateCurrentStats();
  renderLiveMonitors();
}

function makeAnalysisSamples(samples, mode) {
  if (mode !== "stereo") {
    return Int16Array.from(samples);
  }

  const frameCount = Math.floor(samples.length / 2);
  const mono = new Int16Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    const right = samples[i * 2];
    const left = samples[i * 2 + 1];
    mono[i] = Math.round((right + left) / 2);
  }

  return mono;
}

function saveCurrentRecording() {
  const numChannels = audioMode === "stereo" && inputSource === "mems" ? 2 : 1;
  const samples = mergeChunks(currentChunks, currentValueCount);
  const analysisSamples = makeAnalysisSamples(samples, numChannels === 2 ? "stereo" : "mono");
  const wavBuffer = encodeWav(samples, SAMPLE_RATE, numChannels);

  const blob = new Blob([wavBuffer], {
    type: "audio/wav"
  });

  const url = URL.createObjectURL(blob);
  const duration = currentFrameCount / SAMPLE_RATE;

  const sourceLabel = inputSource === "mems" ? "MEMS" : "Computer mic";

  // One audio per recording. It is already filtered if the Noise filter was ON
  // during capture, or raw if it was OFF — no duplicate copy.
  const filtered = noiseAttenuatorEnabled;

  // Acoustic voice features (research preview) computed once, on save.
  let features = null;
  try {
    features = extractVoiceFeatures(analysisSamples, SAMPLE_RATE);
  } catch (e) {
    console.warn("Feature extraction failed:", e);
  }

  const recording = {
    id: Date.now(),
    number: recordingIndex++,
    frames: currentFrameCount,
    values: currentValueCount,
    duration,
    channels: numChannels,
    mode: inputSource === "mems" ? audioMode : "computer",
    source: sourceLabel,
    samples,
    analysisSamples,
    blob,
    url,
    filtered,
    features,
    meta: activeTestMeta,
    createdAt: new Date()
  };

  recordings.unshift(recording);

  renderRecordings();
  updateAnalysisSourceSelect();

  // Persist so the recording survives a refresh (best-effort, non-blocking).
  saveRecordingToDb(recording);

  // Let the clinical view update its session review if this was a clinical take.
  if (recording.meta && typeof onClinicalRecordingSaved === "function") {
    onClinicalRecordingSaved(recording);
  }

  log("Recording " + recording.number + " saved from " + sourceLabel + ".");
}

function mergeChunks(chunks, totalValues) {
  const samples = new Int16Array(totalValues);
  let offset = 0;

  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  return samples;
}

function encodeWav(samples, sampleRate, numChannels) {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);

  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i], true);
    offset += 2;
  }

  return buffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function renderRecordings() {
  recordingList.innerHTML = "";

  // R&D Library shows only R&D takes. Clinical takes (meta set) live in the
  // patient chart on the Clinical side, not here.
  const libraryRecordings = recordings.filter(r => !r.meta);

  recordingCount.textContent = libraryRecordings.length + " saved";

  if (libraryRecordings.length === 0) {
    recordingList.innerHTML = '<div class="empty">No recordings yet.</div>';
    return;
  }

  for (const recording of libraryRecordings) {
    const card = document.createElement("div");
    card.className = "recordingCard";

    const title = document.createElement("div");
    title.className = "recordingTitle";
    title.textContent = recording.name || "Recording " + recording.number;

    const info = document.createElement("div");
    info.className = "recordingInfo";
    let infoText =
        recording.duration.toFixed(2) + " s · " +
        recording.source + " · " +
        recording.mode + " · " +
        recording.channels + " channel(s) · " +
        recording.createdAt.toLocaleTimeString();
    if (recording.meta && recording.meta.patientId) {
      infoText = recording.meta.patientId + " · " + recording.meta.testName + " · " + infoText;
    }
    if (recording.filtered) {
      infoText = "🧹 filtered · " + infoText;
    }
    info.textContent = infoText;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = recording.url;

    const buttons = document.createElement("div");
    buttons.className = "cardButtons";

    const analyzeBtn = document.createElement("button");
    analyzeBtn.className = "smallBtn analyzeBtn";
    analyzeBtn.textContent = "Analyze FFT";
    analyzeBtn.onclick = () => analyzeRecording(recording.id);

    const renameBtn = document.createElement("button");
    renameBtn.className = "smallBtn";
    renameBtn.textContent = "Rename";
    renameBtn.onclick = () => renameRecording(recording.id);

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "smallBtn downloadBtn";
    downloadBtn.textContent = "Download WAV";
    downloadBtn.onclick = () => downloadRecording(recording);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "smallBtn deleteBtn";
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = () => deleteRecording(recording.id);

    buttons.appendChild(analyzeBtn);
    buttons.appendChild(renameBtn);
    buttons.appendChild(downloadBtn);
    buttons.appendChild(deleteBtn);

    card.appendChild(title);
    card.appendChild(info);
    card.appendChild(audio);

    if (recording.features && typeof formatFeatures === "function") {
      const feat = document.createElement("div");
      feat.className = "featureLine";
      feat.textContent = "🧬 " + formatFeatures(recording.features);
      card.appendChild(feat);
    }

    card.appendChild(buttons);

    recordingList.appendChild(card);
  }
}

function updateAnalysisSourceSelect() {
  const currentValue = analysisSourceSelect.value;

  analysisSourceSelect.innerHTML = '<option value="live">Live buffer</option>';

  for (const recording of recordings) {
    const option = document.createElement("option");
    option.value = "recording-" + recording.id;

    let label;
    if (recording.name) {
      label = recording.name;
    } else if (recording.meta && recording.meta.patientId) {
      label = recording.meta.patientId + " · " + recording.meta.testName;
    } else {
      label = "Recording " + recording.number + " · " + recording.source + " · " + recording.mode;
    }
    option.textContent = label + " · " + recording.duration.toFixed(2) + " s";

    analysisSourceSelect.appendChild(option);
  }

  const stillExists = Array.from(analysisSourceSelect.options).some(opt => opt.value === currentValue);

  if (stillExists) {
    analysisSourceSelect.value = currentValue;
  }
  
  resetAnalysisSelection();
}

function analyzeRecording(recordingId) {
  analysisSourceSelect.value = "recording-" + recordingId;
  resetAnalysisSelection();
  showTab("analyzeView");
  plotNoiseSpectrum();
}

function sanitizeForFilename(text) {
  return String(text).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

// Build a descriptive base filename: a custom name if set, otherwise
// PatientID__Session__Test__timestamp for clinical takes, else a generic name.
function recordingBaseName(recording) {
  const timestamp = recording.createdAt.toISOString().replace(/[:.]/g, "-");

  if (recording.name) {
    return sanitizeForFilename(recording.name) + "_" + timestamp;
  }

  if (recording.meta && recording.meta.patientId) {
    return [
      sanitizeForFilename(recording.meta.patientId),
      sanitizeForFilename(recording.meta.sessionId || "session"),
      sanitizeForFilename(recording.meta.testId || "test"),
      timestamp
    ].join("__");
  }

  return "audiomx_recording_" + recording.number + "_" +
    recording.source.replace(/\s+/g, "_").toLowerCase() + "_" +
    recording.mode + "_" + timestamp;
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadRecording(recording) {
  triggerDownload(recording.url, recordingBaseName(recording) + ".wav");
  log("Recording " + recording.number + " downloaded.");
}

function renameRecording(id) {
  const target = recordings.find(r => r.id === id);
  if (!target) return;

  const current = target.name || "Recording " + target.number;
  const next = prompt("Rename recording:", current);
  if (next === null) return;

  target.name = next.trim() || null;

  renderRecordings();
  updateAnalysisSourceSelect();
  if (typeof renderPatientChart === "function") renderPatientChart();
  saveRecordingToDb(target);

  log("Recording renamed to: " + (target.name || "Recording " + target.number));
}

function deleteRecording(id) {
  const target = recordings.find(r => r.id === id);

  if (target) {
    URL.revokeObjectURL(target.url);
  }

  recordings = recordings.filter(r => r.id !== id);

  if (recordings.length === 0) {
    startBtn.textContent = "Start";
  }

  deleteRecordingFromDb(id);

  renderRecordings();
  updateAnalysisSourceSelect();

  log("Recording deleted.");
}