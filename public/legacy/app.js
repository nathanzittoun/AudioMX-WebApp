const SAMPLE_RATE = 16000;
const BAUD_RATE = 921600;
const MAX_LIVE_SAMPLES = 16000;
const FFT_SIZE = 4096;

let port;
let reader;
let writer;

// Device and capture state now live in src/core/state.ts; bridge.ts installs
// globalThis accessors for inputSource, memsConnectionType, isConnected,
// isRecording, audioMode and noiseAttenuatorEnabled. A `let` here would shadow
// them and split the source of truth.

// Metadata attached to the next saved recording (set by the clinical flow).
let activeTestMeta = null;

let wifiSocket = null;
let wifiConnected = false;

let computerAudioContext = null;
let computerMediaStream = null;
let computerSourceNode = null;
let computerProcessorNode = null;
let computerMicReady = false;
// The rate the browser actually gave us, which is not always the one we asked
// for. computerMic.js resamples to SAMPLE_RATE when they differ.
let computerCaptureRate = SAMPLE_RATE;

function log(message) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.textContent = "[" + time + "] " + message;
  logDiv.appendChild(line);
  logDiv.scrollTop = logDiv.scrollHeight;
}

function setAppMode(mode) {
  appMode = mode;

  const rnd = document.getElementById("rndMode");
  const clinical = document.getElementById("clinicalMode");
  if (rnd) rnd.hidden = mode !== "rnd";
  if (clinical) clinical.hidden = mode !== "clinical";

  document.querySelectorAll(".modeSwitchBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

// Route the live monitors to whichever area is active.
// Called once per audio buffer from the capture callbacks, which run on the
// main thread. Drawing synchronously there can overrun the buffer period and
// make the audio engine drop samples — heard as periodic gaps in the take.
// Coalescing to one draw per animation frame keeps the monitors smooth while
// letting the capture callback return immediately.
let liveMonitorFrame = 0;

function renderLiveMonitors() {
  if (liveMonitorFrame) return;
  liveMonitorFrame = requestAnimationFrame(() => {
    liveMonitorFrame = 0;
    drawLiveMonitorsNow();
  });
}

function drawLiveMonitorsNow() {
  if (appMode === "clinical") {
    drawClinicalMonitors();
  } else {
    drawLiveWaveform();
    drawLiveSpectrum();
    updateNoiseIndicators(liveSamples);
  }
}

function clearActiveMonitors() {
  // Drop any coalesced draw still queued, or it would repaint stale samples
  // over the canvases we are about to clear.
  if (liveMonitorFrame) {
    cancelAnimationFrame(liveMonitorFrame);
    liveMonitorFrame = 0;
  }
  clearCanvas();
  clearLiveSpectrogram();
  if (typeof clearClinicalMonitors === "function") {
    clearClinicalMonitors();
  }
}

function setStatus(message, state = "idle") {
  statusDiv.textContent = message;
  statusDot.className = "statusDot";

  if (state === "connected") {
    statusDot.classList.add("connected");
  }

  if (state === "recording") {
    statusDot.classList.add("recording");
  }
}

function updateCurrentStats() {
  const duration = currentFrameCount / SAMPLE_RATE;
  const channelText = audioMode === "stereo" ? "2 channels" : "1 channel";

  durationBox.textContent = "Duration: " + duration.toFixed(2) + " s";
  sampleBox.textContent = "Frames: " + currentFrameCount + " · " + channelText;
  recordingStateBox.textContent = isRecording ? "Recording" : "Idle";
}

async function sendMemsCommand(command) {
  if (memsConnectionType === "wifi") {
    sendWifiCommand(command);
    return;
  }

  await sendCommand(command);
}

function clearCanvas() {
  ctx.fillStyle = "#f0f0f2";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#d8d8dc";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = (canvas.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#b8b8bd";
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();

  // Amplitude axis (y): the waveform maps ±full-scale to ±0.42·height.
  ctx.fillStyle = "#8a8a8d";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, Arial";
  ctx.fillText("+1.0", 6, canvas.height / 2 - canvas.height * 0.42 + 11);
  ctx.fillText("0", 6, canvas.height / 2 - 4);
  ctx.fillText("-1.0", 6, canvas.height / 2 + canvas.height * 0.42 - 3);
  ctx.fillText("amplitude (× full scale)", 6, 14);

  // Time axis (x): the rolling buffer holds the most recent ~1 s.
  ctx.fillText("time →  (~1 s rolling)", canvas.width - 150, canvas.height - 8);
}

function drawLiveWaveform() {
  clearCanvas();

  if (liveSamples.length < 2) {
    return;
  }

  ctx.strokeStyle = "#b31b1b";
  ctx.lineWidth = 2;
  ctx.beginPath();

  const step = Math.max(1, Math.floor(liveSamples.length / canvas.width));
  let x = 0;

  for (let i = 0; i < liveSamples.length; i += step) {
    const sample = liveSamples[i] / 32768;
    const y = canvas.height / 2 - sample * canvas.height * 0.42;

    if (x === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }

    x++;

    if (x >= canvas.width) {
      break;
    }
  }

  ctx.stroke();
}

async function startRecording() {
  if (!isConnected) {
    return;
  }

  resetNoiseAttenuator();

  currentChunks = [];
  currentFrameCount = 0;
  currentValueCount = 0;
  liveSamples = [];
  byteBuffer = [];

  // Drop ~0.2 s of USB start-up transient; no warm-up needed on Wi-Fi/computer.
  recordingWarmupFrames =
    inputSource === "mems" && memsConnectionType === "usb"
      ? Math.round(SAMPLE_RATE * 0.2)
      : 0;

  isRecording = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setStatus("Recording", "recording");
  updateCurrentStats();
  clearActiveMonitors();

  if (inputSource === "mems") {
    await sendMemsCommand("START");
  } else if (inputSource === "computer") {
    startComputerMicCapture();
  }
}

async function stopRecording() {
  if (!isConnected || !isRecording) {
    return;
  }

  isRecording = false;

  if (inputSource === "mems") {
    await sendMemsCommand("STOP");
  } else if (inputSource === "computer") {
    stopComputerMicCapture();
  }

  startBtn.disabled = false;
  stopBtn.disabled = true;

  if (currentFrameCount > 0) {
    saveCurrentRecording();
    setStatus("Recording saved", "connected");
    startBtn.textContent = "New recording";
  } else {
    setStatus("Stopped", "connected");
  }

  updateCurrentStats();
}

async function setInputSource(source) {
  if (isRecording) {
    log("Cannot change input source while recording.");
    return;
  }

  if (inputSource === source) {
    return;
  }

  await disconnectCurrentSource();

  inputSource = source;

  document.querySelectorAll(".sourceBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.source === source);
  });

  isConnected = false;

  connectBtn.disabled = false;
  startBtn.disabled = true;
  stopBtn.disabled = true;
  calibrateNoiseBtn.disabled = true;
  plotSpectrumBtn.disabled = true;
  noiseAttenuatorBtn.disabled = true;

  // The Wi-Fi button only makes sense for the MEMS device; hide it entirely
  // for the computer mic.
  connectWifiBtn.disabled = source !== "mems";
  connectWifiBtn.style.display = source === "mems" ? "" : "none";

  if (source === "mems") {
    connectBtn.textContent = "Connect MEMS device";
    modeSelector.style.display = "grid";
    setAudioMode("stereo");
    setStatus("MEMS selected", "idle");
  }

  if (source === "computer") {
    connectBtn.textContent = "Connect computer mic";
    modeSelector.style.display = "none";
    audioMode = "computer";
    updateCurrentStats();
    setStatus("Computer mic selected", "idle");
  }

  log("Input source selected: " + source + ".");
}

async function disconnectCurrentSource() {
  // This path is always a deliberate teardown, so suppress the serial/Wi-Fi
  // auto-reconnect logic that only fires on unexpected drops.
  serialIntentionalClose = true;

  try {
    if (reader) {
      await reader.cancel();
      reader.releaseLock();
      reader = null;
    }
  } catch (error) {
    console.warn("Reader disconnect issue:", error);
  }

  try {
    if (writer) {
      writer.releaseLock();
      writer = null;
    }
  } catch (error) {
    console.warn("Writer disconnect issue:", error);
  }

  try {
    if (port) {
      await port.close();
      port = null;
    }
  } catch (error) {
    console.warn("Serial port close issue:", error);
  }

  try {
    if (computerProcessorNode) {
      computerProcessorNode.disconnect();
      computerProcessorNode = null;
    }

    if (computerSourceNode) {
      computerSourceNode.disconnect();
      computerSourceNode = null;
    }

    if (computerMediaStream) {
      computerMediaStream.getTracks().forEach(track => track.stop());
      computerMediaStream = null;
    }

    if (computerAudioContext) {
      await computerAudioContext.close();
      computerAudioContext = null;
    }

    computerMicReady = false;
  } catch (error) {
    console.warn("Computer mic disconnect issue:", error);
  }

  try {
    disconnectWifi();
  } catch (error) {
    console.warn("Wi-Fi disconnect issue:", error);
  }

  isConnected = false;
  wifiConnected = false;
  noiseAttenuatorBtn.disabled = true;
}