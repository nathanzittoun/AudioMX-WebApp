// Capture bookkeeping and the R&D library view. WAV assembly moved to
// src/core/wav.ts.

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

// addSamples moved to src/core/recorder.ts as ingestMemsFrame().

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
    meta: pendingTestMeta,
    createdAt: new Date()
  };

  // Consumed: the next take must not inherit this one's patient.
  pendingTestMeta = null;

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