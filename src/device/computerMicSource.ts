// The computer's own microphone, via getUserMedia.
//
// The one input available on every platform, including iOS — which is why it is
// the fallback the capability messages point at when USB or Wi-Fi are out.

import { SAMPLE_RATE } from "../core/constants";
import { audioContext } from "../core/audioContext";
import { capture, device } from "../core/state";
import { ingest } from "../core/recorder";
import { el } from "../ui/dom";
import { computerMicSupport } from "./support";
import { createResampler } from "./resample";
import { log } from "../ui/log";
import { setStatus } from "../ui/status";

/**
 * Frames per block handed to the ingest path, at the capture rate. Also the
 * size of the problem in preRollFrames() below. Both paths use it, so the
 * timing the rest of the app sees does not depend on which one is running.
 */
const PROCESSOR_BUFFER = 4096;

const resampler = createResampler();

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let workletNode: AudioWorkletNode | null = null;
/** Set while a stop is waiting for the worklet's tail. */
let drainResolve: (() => void) | null = null;

/** Native rate of the open context. Exposed for diagnostics and tests. */
export function captureRate(): number {
  return context?.sampleRate ?? SAMPLE_RATE;
}

export function isReady(): boolean {
  return context !== null;
}

/** Which capture path is live. "none" until the microphone is connected. */
export function captureMode(): "worklet" | "script" | "none" {
  if (workletNode) return "worklet";
  if (processorNode) return "script";
  return "none";
}

/**
 * How much audio the first block after Start carries from *before* Start.
 *
 * A ScriptProcessor hands over a buffer that has already been filling while we
 * were not recording, so the first block to arrive covers a window reaching
 * back up to one buffer. Recording it verbatim means the take opens with the
 * room as it was before the clinician pressed anything — and, in the clinical
 * exam, with the countdown's go tone.
 *
 * Zero on the worklet path, and that is the better fix rather than a shortcut:
 * the worklet is told to drop its partial buffer at Start, so nothing from
 * before Start survives to be skipped. Keeping a non-zero skip there would
 * throw away a block of real audio from *after* Start — the opposite mistake,
 * and a harder one to notice.
 *
 * Returned in frames at SAMPLE_RATE, which is what the ingest path counts, so
 * it stays correct when the browser refuses our rate and we resample.
 */
export function preRollFrames(): number {
  if (workletNode) return 0;
  return Math.ceil((PROCESSOR_BUFFER * SAMPLE_RATE) / captureRate());
}

/** One block of captured audio, converted and handed to the recorder. */
function takeBlock(input: Float32Array, rate: number): void {
  if (!capture.recording || device.sourceId !== "computer") return;
  convertAndIngest(input, rate);
}

function convertAndIngest(input: Float32Array, rate: number): void {

  const source = rate === SAMPLE_RATE
    ? input
    : resampler.process(input, rate, SAMPLE_RATE);

  const samples = new Int16Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const s = Math.max(-1, Math.min(1, source[i]));
    samples[i] = Math.round(s * 32767);
  }

  ingest(samples, 1);
}

/**
 * Put the microphone on the audio thread if this browser can, and on the main
 * thread if it cannot.
 *
 * The worklet is not an optimisation. A ScriptProcessor callback that arrives
 * while the main thread is drawing a waveform and running an FFT for the live
 * spectrum is late, and a late block is dropped outright — the audio in it is
 * gone from the take. On the audio thread the schedule cannot be delayed by
 * main-thread work, and a block that arrives late merely arrives late.
 *
 * The fallback is the old path verbatim, for a browser without AudioWorklet.
 */
async function attachCapture(
  ctx: AudioContext, source: MediaStreamAudioSourceNode, rate: number
): Promise<void> {
  if (ctx.audioWorklet) {
    try {
      // Served from public/ rather than imported. Vite inlines a small asset as
      // a data: URI, and addModule() refuses one — the module has to come from a
      // real, same-origin address. BASE_URL is what makes it resolve both at "/"
      // in dev and under the Pages sub-path in the build.
      await ctx.audioWorklet.addModule(import.meta.env.BASE_URL + "capture-worklet.js");
      workletNode = new AudioWorkletNode(ctx, "audiomx-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      workletNode.port.onmessage = event => {
        const data = event.data as Float32Array | { drained: Float32Array | null };
        if (data instanceof Float32Array) {
          takeBlock(data, rate);
          return;
        }
        // The tail, answering a drain. Only accepted while a stop is actually
        // waiting for it: the wait times out after 150 ms so a take is never
        // lost to a missing message, and a reply arriving after that would
        // otherwise be counted into a recording that has already been saved —
        // corrupting the *next* take rather than this one.
        if (!drainResolve) return;
        // Bypasses takeBlock's recording guard on purpose: this is the audio
        // captured before Stop, and the flag is about to go down.
        if (data.drained) convertAndIngest(data.drained, rate);
        drainResolve();
      };
      // No output, so nothing to connect to the destination — which also means
      // the microphone is never routed to the speakers.
      source.connect(workletNode);
      return;
    } catch (error) {
      console.warn("AudioWorklet unavailable, falling back:", error);
      workletNode = null;
    }
  }

  log("This browser has no AudioWorklet; capture runs on the main thread and " +
    "may drop blocks while the live monitors are drawing.");
  processorNode = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
  processorNode.onaudioprocess = event => {
    takeBlock(event.inputBuffer.getChannelData(0), rate);
  };
  source.connect(processorNode);
  processorNode.connect(ctx.destination);
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

    // The one shared context — see core/audioContext.ts. Opening a second one
    // here is what silently killed this very input on macOS.
    context = audioContext();
    if (!context) {
      setStatus("Microphone unavailable", "idle");
      log("This browser has no Web Audio support, so the microphone cannot be read.");
      return;
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
    await attachCapture(context, sourceNode, rate);

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
  // Drop what the worklet has collected but not yet posted, so the take opens
  // at Start rather than reaching back over a whole block. The warm-up skip in
  // startRecording() still covers the block already in flight.
  workletNode?.port.postMessage("flush");
  resampler.reset();
  log("Computer mic recording started.");
}

/**
 * End a take, and wait for the audio still sitting in the worklet.
 *
 * A block is only posted once it is full, so at the moment Stop is pressed up
 * to one block — 256 ms — has been captured and never delivered. It used to be
 * dropped on the floor: every take lost up to a quarter second off its end,
 * silently, including the maximum phonation time test whose entire result is
 * that duration.
 *
 * Resolves on a timer as well as on the answer, because a take must never be
 * lost waiting for a message that is not coming.
 */
export function stopComputerMicCapture(): Promise<void> {
  log("Computer mic recording stopped.");
  const node = workletNode;
  if (!node) return Promise.resolve();

  return new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      drainResolve = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 150);
    drainResolve = finish;
    node.port.postMessage("drain");
  });
}

/** Release the microphone and tear the graph down. */
export async function disconnectComputerMic(): Promise<void> {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
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
  // The context itself stays open on purpose: closing and reopening it is the
  // device reconfiguration this whole arrangement exists to avoid, and the
  // countdown beeps share it. Dropping the reference is enough — the graph is
  // disconnected and the tracks are stopped, so nothing is left running.
  context = null;
  resampler.reset();
}
