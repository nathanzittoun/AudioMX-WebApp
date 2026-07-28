// Application shell and capture controls, formerly public/legacy/app.js.

import { SAMPLE_RATE } from "./core/constants";
import { resetNoiseAttenuator } from "./core/dsp/noiseFilter";
import { saveCurrentRecording } from "./core/recorder";
import { capture, device, ui, type RecordingMeta, type SourceId } from "./core/state";
import {
  disconnectComputerMic, preRollFrames, startComputerMicCapture, stopComputerMicCapture,
} from "./device/computerMicSource";
import { closeSerialPort, sendCommand } from "./device/serialSource";
import { disconnectWifi, sendWifiCommand } from "./device/wifiSource";
import { setAudioMode } from "./rnd/libraryView";
import { drawLiveSpectrum } from "./rnd/liveSpectrum";
import { updateNoiseIndicators } from "./rnd/meters";
import { clearLiveSpectrogram } from "./ui/canvas/spectrogram";
import { ctx2d, el } from "./ui/dom";
import { reflectNav } from "./ui/nav";
import { PLOT } from "./ui/theme";
import { log } from "./ui/log";
import { setStatus } from "./ui/status";
import { updateCurrentStats } from "./ui/captureStats";
import { emit, on } from "./core/bus";

// "home" is the overview page: a third top-level container, and the one the app
// opens on. It is a valid value of ui.mode rather than a special case outside
// it, because every existing test on ui.mode asks "is this clinical?" — so a
// third value answers no, exactly as it should, everywhere it is read.
export function setAppMode(mode: "rnd" | "clinical" | "home"): void {
  ui.mode = mode;
  const home = el("homeMode");
  const rnd = el("rndMode");
  const clinical = el("clinicalMode");
  if (home) home.hidden = mode !== "home";
  if (rnd) rnd.hidden = mode !== "rnd";
  if (clinical) clinical.hidden = mode !== "clinical";
  reflectNav();
}

let liveMonitorFrame = 0;

// The ingest path announces every block it takes in; this is what turns that
// into a repaint. The subscription is the whole point of the event and its
// absence is invisible: renderLiveMonitors() is exported, so an unused-symbol
// check cannot see that nothing calls it, and the monitors simply stay blank.
on("capture:tick", () => renderLiveMonitors());

export function renderLiveMonitors(): void {
  if (liveMonitorFrame) return;
  liveMonitorFrame = requestAnimationFrame(() => {
    liveMonitorFrame = 0;
    if (ui.mode === "clinical") {
      // Announced, not called: clinical.ts imports this module for the capture
      // controls, so importing it back would be a cycle.
      emit("monitors:tick", undefined);
    } else if (ui.mode === "rnd") {
      drawLiveWaveform();
      drawLiveSpectrum();
      updateNoiseIndicators(capture.live);
    }
    // On the overview page there is no monitor on screen to repaint. Capture
    // itself is driven by the ingest path, not by this frame, so a take that
    // is running keeps running and simply redraws on return.
  });
}

function clearActiveMonitors(): void {
  if (liveMonitorFrame) {
    cancelAnimationFrame(liveMonitorFrame);
    liveMonitorFrame = 0;
  }
  clearCanvas();
  clearLiveSpectrogram();
  emit("monitors:clear", undefined);
}

async function sendMemsCommand(command: string): Promise<void> {
  if (device.transport === "wifi") {
    sendWifiCommand(command);
    return;
  }
  await sendCommand(command);
}

export function clearCanvas(): void {
  const canvas = el<HTMLCanvasElement>("waveform");
  const ctx = ctx2d("waveform");
  if (!canvas || !ctx) return;

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

  ctx.fillStyle = "#8a8a8d";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, Arial";
  ctx.fillText("+1.0", 6, canvas.height / 2 - canvas.height * 0.42 + 11);
  ctx.fillText("0", 6, canvas.height / 2 - 4);
  ctx.fillText("-1.0", 6, canvas.height / 2 + canvas.height * 0.42 - 3);
  ctx.fillText("amplitude (× full scale)", 6, 14);
  ctx.fillText("time →  (~1 s rolling)", canvas.width - 150, canvas.height - 8);
}

function drawLiveWaveform(): void {
  clearCanvas();
  const canvas = el<HTMLCanvasElement>("waveform");
  const ctx = ctx2d("waveform");
  if (!canvas || !ctx || capture.live.length < 2) return;

  ctx.strokeStyle = PLOT.trace;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(capture.live.length / canvas.width));
  let x = 0;
  for (let i = 0; i < capture.live.length; i += step) {
    const sample = capture.live[i] / 32768;
    const y = canvas.height / 2 - sample * canvas.height * 0.42;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x++;
    if (x >= canvas.width) break;
  }
  ctx.stroke();
}

export async function startRecording(meta?: RecordingMeta | null): Promise<void> {
  if (!device.connected) return;

  capture.pendingMeta = meta || null;
  resetNoiseAttenuator();
  capture.chunks = [];
  capture.frames = 0;
  capture.values = 0;
  capture.live = [];
  // Audio to discard before the take really begins. Two different reasons:
  // USB has a power-on thump as the port opens, and the computer mic's first
  // block reaches back before Start (see preRollFrames). Wi-Fi has neither.
  if (device.sourceId === "computer") {
    capture.warmupFrames = preRollFrames();
  } else if (device.transport === "usb") {
    capture.warmupFrames = Math.round(SAMPLE_RATE * 0.2);
  } else {
    capture.warmupFrames = 0;
  }
  capture.recording = true;

  const startBtn = el<HTMLButtonElement>("startBtn");
  const stopBtn = el<HTMLButtonElement>("stopBtn");
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  setStatus("Recording", "recording");
  updateCurrentStats();
  clearActiveMonitors();

  if (device.sourceId === "mems") await sendMemsCommand("START");
  else if (device.sourceId === "computer") startComputerMicCapture();
}

export async function stopRecording(): Promise<void> {
  if (!device.connected || !capture.recording) return;
  capture.recording = false;

  if (device.sourceId === "mems") await sendMemsCommand("STOP");
  else if (device.sourceId === "computer") stopComputerMicCapture();

  const startBtn = el<HTMLButtonElement>("startBtn");
  const stopBtn = el<HTMLButtonElement>("stopBtn");
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;

  if (capture.frames > 0) {
    saveCurrentRecording();
    setStatus("Recording saved", "connected");
    if (startBtn) startBtn.textContent = "New recording";
  } else {
    setStatus("Stopped", "connected");
  }
  updateCurrentStats();
}

export async function setInputSource(source: SourceId): Promise<void> {
  if (capture.recording) {
    log("Cannot change input source while recording.");
    return;
  }
  if (device.sourceId === source) return;

  await disconnectCurrentSource();
  device.sourceId = source;
  document.querySelectorAll<HTMLElement>(".sourceBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["source"] === source);
  });
  device.connected = false;

  const connectBtn = el<HTMLButtonElement>("connectBtn");
  const startBtn = el<HTMLButtonElement>("startBtn");
  const stopBtn = el<HTMLButtonElement>("stopBtn");
  const calibrateBtn = el<HTMLButtonElement>("calibrateNoiseBtn");
  const plotBtn = el<HTMLButtonElement>("plotSpectrumBtn");
  const filterBtn = el<HTMLButtonElement>("noiseAttenuatorBtn");
  const wifiBtn = el<HTMLButtonElement>("connectWifiBtn");
  const modeSelector = el("modeSelector");

  if (connectBtn) connectBtn.disabled = false;
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  if (calibrateBtn) calibrateBtn.disabled = true;
  if (plotBtn) plotBtn.disabled = true;
  if (filterBtn) filterBtn.disabled = true;
  if (wifiBtn) {
    wifiBtn.disabled = source !== "mems";
    wifiBtn.style.display = source === "mems" ? "" : "none";
  }

  if (source === "mems") {
    if (connectBtn) connectBtn.textContent = "Connect MEMS device";
    if (modeSelector) modeSelector.style.display = "grid";
    setAudioMode("stereo");
    setStatus("MEMS selected", "idle");
  } else {
    if (connectBtn) connectBtn.textContent = "Connect computer mic";
    if (modeSelector) modeSelector.style.display = "none";
    capture.channelMode = "computer";
    updateCurrentStats();
    setStatus("Computer mic selected", "idle");
  }
  log("Input source selected: " + source + ".");
}

async function disconnectCurrentSource(): Promise<void> {
  await closeSerialPort();
  try {
    await disconnectComputerMic();
  } catch (error) {
    console.warn("Computer mic disconnect issue:", error);
  }
  try {
    disconnectWifi();
  } catch (error) {
    console.warn("Wi-Fi disconnect issue:", error);
  }
  device.connected = false;
  const button = el<HTMLButtonElement>("noiseAttenuatorBtn");
  if (button) button.disabled = true;
}
