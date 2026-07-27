// The application's one and only AudioContext.
//
// This is not tidiness, it is a bug fix. On macOS every AudioContext maps to a
// CoreAudio device configuration, and opening a second one makes the OS
// reconfigure the shared device — which silently kills the input of the first.
// The clinical exam hit this exactly: the microphone opened one context, the
// countdown beeps opened another, and the take that followed came out the
// right length and completely silent. The ScriptProcessor kept firing; its
// input buffers were all zeros.
//
// An earlier attempt narrowed this from six contexts (one per beep, opened and
// closed) down to two (one for the mic, one long-lived for the beeps). Two is
// still one too many. Everything that makes or captures sound shares this one.
//
// The rate is pinned to SAMPLE_RATE so the capture path never has to resample.
// A browser is free to refuse — Safari does — so callers must read
// `context.sampleRate` rather than assume, which computerMicSource does.

import { SAMPLE_RATE } from "./constants";

let shared: AudioContext | null = null;

/** Safari still only ships the prefixed constructor. */
function constructor(): typeof AudioContext | undefined {
  return window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/**
 * The shared context, created on first use. Null only where Web Audio is
 * missing entirely, which no supported browser is.
 *
 * Resumes on every call: the autoplay policy parks a context created outside a
 * user gesture, and resuming an already-running one is a no-op.
 */
export function audioContext(): AudioContext | null {
  const AC = constructor();
  if (!AC) return null;

  if (!shared) {
    try {
      shared = new AC({ sampleRate: SAMPLE_RATE });
    } catch {
      // A device already open at another rate, or a browser that refuses the
      // hint. Take whatever rate we are given; the capture path resamples.
      shared = new AC();
    }
  }

  if (shared.state === "suspended") void shared.resume();
  return shared;
}

/** True when a context exists. Lets a caller avoid opening one just to look. */
export function hasAudioContext(): boolean {
  return shared !== null;
}

/**
 * Close it. Nothing in the app calls this — the context is deliberately kept
 * open for the page's lifetime, because closing and reopening is the device
 * reconfiguration this module exists to avoid. Here for tests and teardown.
 */
export async function closeAudioContext(): Promise<void> {
  if (!shared) return;
  await shared.close();
  shared = null;
}
