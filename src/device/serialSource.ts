// USB-C serial transport for the MEMS device (Web Serial).
//
//   - Detects a physical unplug and a dropped read loop, and reflects the loss
//     in the UI instead of pretending to still be connected.
//   - Distinguishes a user-initiated disconnect from an unexpected one, so the
//     reconnect logic does not fire on a deliberate close.
//
// Chrome and Edge on a computer only. Safari and iOS have no Web Serial —
// serialSupport() reports that before anything here is reached.

import { BAUD_RATE } from "../core/constants";
import { capture, device } from "../core/state";
import { ingestMemsFrame } from "../core/recorder";
import { el } from "../ui/dom";
import { createFrameParser } from "./framing";
import { serialSupport } from "./support";
import { connectComputerMic } from "./computerMicSource";
import { log } from "../ui/log";
import { setStatus } from "../ui/status";

const parser = createFrameParser();

let port: SerialPort | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

/**
 * True while a close was asked for. Without it, the read loop ending during a
 * deliberate disconnect would be reported to the clinician as a lost device.
 */
let intentionalClose = false;

export function setIntentionalClose(value: boolean): void {
  intentionalClose = value;
}

export function hasWriter(): boolean {
  return writer !== null;
}

function setButtons(connected: boolean): void {
  const state: Array<[string, boolean]> = [
    ["connectBtn", connected],
    ["startBtn", !connected],
    ["stopBtn", true],
    ["calibrateNoiseBtn", !connected],
    ["plotSpectrumBtn", !connected],
    ["noiseAttenuatorBtn", !connected],
  ];
  for (const [id, disabled] of state) {
    const button = el<HTMLButtonElement>(id);
    if (button) button.disabled = disabled;
  }
}

export async function connectSerial(): Promise<void> {
  // The R&D Connect button is shared, so it dispatches on the selected source.
  if (device.sourceId === "computer") {
    await connectComputerMic();
    return;
  }

  const support = serialSupport();
  if (!support.ok) {
    setStatus("USB unavailable", "idle");
    log(support.reason);
    return;
  }

  try {
    await openSerialPort(await navigator.serial.requestPort());
  } catch (error) {
    console.error(error);
    setStatus("Connection failed", "idle");
    log("Connection error: " + (error as Error).message);
  }
}

export async function openSerialPort(selectedPort: SerialPort): Promise<void> {
  port = selectedPort;
  await port.open({ baudRate: BAUD_RATE });

  reader = port.readable.getReader();
  writer = port.writable.getWriter();

  device.connected = true;
  device.transport = "usb";
  intentionalClose = false;
  parser.reset();

  setButtons(true);
  setStatus("Connected", "connected");
  log("Connected to ESP32 over USB-C serial.");

  void readLoop();
}

async function readLoop(): Promise<void> {
  while (device.connected && reader) {
    try {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        for (const frame of parser.push(value)) ingestMemsFrame(frame);
      }
    } catch (error) {
      console.error(error);
      log("Read error: " + (error as Error).message);
      break;
    }
  }

  // The read loop only ends when the port closes. If nobody asked for that,
  // the device was pulled.
  if (!intentionalClose && device.transport === "usb") {
    handleSerialDisconnected();
  }
}

export function handleSerialDisconnected(): void {
  device.connected = false;
  capture.recording = false;

  reader = null;
  writer = null;
  port = null;
  parser.reset();

  setButtons(false);
  setStatus("USB disconnected", "idle");
  log("USB serial connection lost. Reconnect the device and press Connect.");
}

export async function sendCommand(command: string): Promise<void> {
  if (!writer) {
    setStatus("Not connected", "idle");
    return;
  }
  await writer.write(new TextEncoder().encode(command + "\n"));
  log("APP_SENT:" + command);
}

/** Release the port. Safe to call when nothing is open. */
export async function closeSerialPort(): Promise<void> {
  intentionalClose = true;
  try {
    if (reader) {
      await reader.cancel();
      reader.releaseLock();
      reader = null;
    }
    if (writer) {
      writer.releaseLock();
      writer = null;
    }
    if (port) {
      await port.close();
      port = null;
    }
  } catch (error) {
    console.warn("Serial port close issue:", error);
  }
  parser.reset();
}

/**
 * Watch for the device being physically unplugged.
 *
 * Called explicitly from the bootstrap. The legacy version registered this at
 * file-parse time, which made the listener a side effect of loading a script —
 * invisible in any call graph, and impossible to skip on a page that has no
 * business listening for serial events.
 */
export function initSerial(): void {
  if (!("serial" in navigator) || !navigator.serial.addEventListener) return;

  navigator.serial.addEventListener("disconnect", event => {
    if (device.transport === "usb" && port && event.target === port) {
      intentionalClose = false;
      handleSerialDisconnected();
    }
  });
}
