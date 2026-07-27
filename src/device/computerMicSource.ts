// The computer's own microphone, via getUserMedia.
//
// The one input available on every platform, including iOS — which is why it is
// the fallback the capability messages point at when USB or Wi-Fi are out.

import { SAMPLE_RATE } from "../core/constants";
import { capture, device } from "../core/state";
import { ingest } from "../core/recorder";
import { el } from "../ui/dom";
import { computerMicSupport } from "./support";
import { createResampler } from "./resample";
import { log } from "../ui/log";
import { setStatus } from "../ui/status";

const resampler = createResampler();

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;

/** Native rate of the open context. Exposed for diagnostics and tests. */
export function captureRate(): number {
  return context?.sampleRate ?? SAMPLE_RATE;
}

export function isReady(): boolean {
  return context !== null;
}

export async function connectComputerMic(): Promise<void> {
  try {
    const support = computerMicSupport();
    if (!support.ok) {
      setStatus("Microphone unavailable", "idle");
      log(support.reason);
      return;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // All three would alter the signal being measured. A voice biomarker
        // is only meaningful on the microphone's actual output.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch (e) {
      // Safari and some devices reject a forced rate outright.
      context = new AudioContext();
    }

    // Never assume the rate we asked for is the rate we got. Chrome usually
    // honours it, Safari ignores it, and a device already open at another rate
    // can override it. Everything downstream — FFT axis, WAV header, duration —
    // assumes SAMPLE_RATE, so a silent mismatch plays back at the wrong speed.
    const rate = context.sampleRate;
    resampler.reset();
    if (rate !== SAMPLE_RATE) {
      log("Mic runs at " + rate + " Hz; resampling to " + SAMPLE_RATE + " Hz.");
    }

    sourceNode = context.createMediaStreamSource(stream);
    processorNode = context.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = event => {
      if (!capture.recording || device.sourceId !== "computer") return;

      const input = event.inputBuffer.getChannelData(0);
      const source = rate === SAMPLE_RATE
        ? input
        : resampler.process(input, rate, SAMPLE_RATE);

      const samples = new Int16Array(source.length);
      for (let i = 0; i < source.length; i++) {
        const s = Math.max(-1, Math.min(1, source[i]));
        samples[i] = Math.round(s * 32767);
      }

      ingest(samples, 1);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(context.destination);

    device.connected = true;

    for (const [id, disabled] of [
      ["connectBtn", true], ["startBtn", false], ["stopBtn", true],
      ["calibrateNoiseBtn", false], ["plotSpectrumBtn", false], ["noiseAttenuatorBtn", false],
    ] as const) {
      const button = el<HTMLButtonElement>(id);
      if (button) button.disabled = disabled;
    }

    setStatus("Computer mic ready", "connected");
    log("Connected to computer microphone.");
  } catch (error) {
    console.error(error);
    setStatus("Computer mic failed", "idle");
    log("Computer mic error: " + (error as Error).message);
  }
}

export function startComputerMicCapture(): void {
  // The autoplay policy parks a context created outside a gesture; resuming is
  // a no-op when it is already running.
  if (context && context.state === "suspended") void context.resume();
  log("Computer mic recording started.");
}

export function stopComputerMicCapture(): void {
  log("Computer mic recording stopped.");
}

/** Release the microphone and tear the graph down. */
export async function disconnectComputerMic(): Promise<void> {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (stream) {
    // Without this the browser keeps showing the "recording" indicator.
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  if (context) {
    await context.close();
    context = null;
  }
  resampler.reset();
}
