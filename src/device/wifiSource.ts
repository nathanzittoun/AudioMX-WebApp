// Wi-Fi (WebSocket) transport for the MEMS device.
//
//   - The address comes from an input field, so a device joined to your LAN
//     works, not only the fixed 192.168.4.1 access point.
//   - A connection timeout fails fast instead of hanging when the ESP32 is off
//     or you are on the wrong network.
//   - An unexpected drop triggers a bounded, backing-off reconnect; a
//     user-initiated disconnect does not.

import { device } from "../core/state";
import { ingestMemsFrame } from "../core/recorder";
import { el } from "../ui/dom";
import { wifiSupport } from "./support";
import { log } from "../ui/log";
import { setStatus } from "../ui/status";

export const DEFAULT_WIFI_URL = "ws://192.168.4.1:81";
const CONNECT_TIMEOUT_MS = 6000;
export const MAX_RECONNECT_ATTEMPTS = 5;

let socket: WebSocket | null = null;
let connected = false;
let intentionalClose = false;
let reconnectAttempts = 0;
let reconnectTimer: number | undefined;
let connectTimeout: number | undefined;

export function isWifiConnected(): boolean {
  return connected;
}

export function getWifiUrl(): string {
  return el<HTMLInputElement>("wifiUrlInput")?.value.trim() || DEFAULT_WIFI_URL;
}

/**
 * Exponential backoff, capped at 8 s. Pure so the schedule can be checked
 * without waiting through it.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt - 1), 8000);
}

function setButtons(state: "connected" | "idle"): void {
  const on = state === "connected";
  const flags: Array<[string, boolean]> = [
    ["connectBtn", on],
    ["connectWifiBtn", on],
    ["startBtn", !on],
    ["stopBtn", true],
    ["calibrateNoiseBtn", !on],
    ["plotSpectrumBtn", !on],
    ["noiseAttenuatorBtn", !on],
  ];
  for (const [id, disabled] of flags) {
    const button = el<HTMLButtonElement>(id);
    if (button) button.disabled = disabled;
  }
}

export function connectWifiMems(): void {
  if (device.sourceId !== "mems") {
    log("Wi-Fi MEMS can only be used when MEMS mics are selected.");
    return;
  }

  const url = getWifiUrl();

  // Checked up front because the failure is otherwise invisible: an https page
  // refuses a ws:// socket and it simply never opens, which looks exactly like
  // a device that is switched off.
  const support = wifiSupport(url);
  if (!support.ok) {
    setStatus("Wi-Fi unavailable", "idle");
    log(support.reason);
    return;
  }

  intentionalClose = false;
  reconnectAttempts = 0;
  openWifiSocket(url);
}

export function openWifiSocket(url: string): void {
  try {
    setStatus("Connecting to MEMS Wi-Fi...", "idle");
    log("Connecting to ESP32 WebSocket at " + url + " ...");

    device.transport = "wifi";

    if (socket) {
      try { socket.close(); } catch (e) { /* already closing */ }
      socket = null;
    }

    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    clearTimeout(connectTimeout);
    connectTimeout = window.setTimeout(() => {
      if (socket && socket.readyState !== WebSocket.OPEN) {
        log("Wi-Fi connection timed out. Is the ESP32 powered and are you joined to its network?");
        setStatus("Wi-Fi timeout", "idle");
        try { socket.close(); } catch (e) { /* already closing */ }
      }
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(connectTimeout);
      reconnectAttempts = 0;
      connected = true;
      device.connected = true;

      setButtons("connected");
      setStatus("Connected by Wi-Fi", "connected");
      log("Connected to MEMS over Wi-Fi WebSocket.");
    };

    socket.onmessage = event => {
      if (typeof event.data === "string") {
        log("ESP32_WIFI:" + event.data);
        return;
      }
      // A WebSocket message is already one whole frame — no sync bytes and no
      // length prefix, unlike the USB stream — so it goes straight to ingest.
      ingestMemsFrame(new Uint8Array(event.data as ArrayBuffer));
    };

    socket.onerror = error => {
      console.error(error);
      log("Wi-Fi WebSocket error.");
      // onclose fires next and owns the UI and reconnect decision.
    };

    socket.onclose = () => {
      clearTimeout(connectTimeout);
      connected = false;

      // Another transport took over while this was closing.
      if (device.transport !== "wifi") return;

      device.connected = false;
      const start = el<HTMLButtonElement>("startBtn");
      const stop = el<HTMLButtonElement>("stopBtn");
      if (start) start.disabled = true;
      if (stop) stop.disabled = true;

      if (intentionalClose) {
        setButtons("idle");
        setStatus("Wi-Fi disconnected", "idle");
        log("Wi-Fi WebSocket disconnected.");
        return;
      }

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = reconnectDelayMs(reconnectAttempts);

        setStatus("Wi-Fi lost — reconnecting...", "idle");
        log(`Wi-Fi dropped. Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s.`);

        clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => openWifiSocket(url), delay);
      } else {
        setButtons("idle");
        setStatus("Wi-Fi disconnected", "idle");
        log(`Wi-Fi reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Press Connect to retry.`);
      }
    };
  } catch (error) {
    console.error(error);
    setStatus("Wi-Fi connection failed", "idle");
    log("Wi-Fi connection failed: " + (error as Error).message);
  }
}

/** User-initiated disconnect: stop reconnecting and close cleanly. */
export function disconnectWifi(): void {
  intentionalClose = true;

  clearTimeout(reconnectTimer);
  clearTimeout(connectTimeout);

  if (socket) {
    try { socket.close(); } catch (e) { /* already closing */ }
    socket = null;
  }

  connected = false;
}

export function sendWifiCommand(command: string): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("Wi-Fi socket is not connected.");
    setStatus("Wi-Fi not connected", "idle");
    return;
  }

  socket.send(command);
  log("APP_WIFI_SENT:" + command);
}
