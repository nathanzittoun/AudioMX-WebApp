// Shared mutable application state.
//
// This is a holding pen, not a destination. app.js currently keeps ~25 loose
// top-level `let`s that every other file reads and writes; they move here in
// small batches so each step stays reviewable, and then move *down* again into
// whichever module actually owns them (transport state into the device
// sources, analysis state into the R&D views, and so on). By the end this file
// should hold only what is genuinely app-wide.
//
// Plain mutable objects rather than exported variables, because ES module
// bindings are read-only for importers: `import { x }; x = 1` is a compile
// error. Grouping under a namespace object keeps assignment working while
// still making the owner obvious at the call site, and leaves room to swap any
// property for a real accessor later without touching callers.

import type { VoiceFeatures } from "./features";

/**
 * What binds a take to the exam that produced it. Null for R&D takes, which
 * have no patient. Handed to startRecording() by the clinical flow and held in
 * capture.pendingMeta for the duration of that take.
 */
export interface RecordingMeta {
  patientId: string;
  patientName: string;
  sessionId: string;
  testId: string;
  testName: string;
  notes: string;
}

/** Which microphone is selected, and how it is attached. */
export type SourceId = "mems" | "computer";
/** How the MEMS device is reached. Meaningless when sourceId is "computer". */
export type Transport = "usb" | "wifi";
/** Which of the two MEMS channels ends up in the stored take. */
export type ChannelMode = "stereo" | "left" | "right";
/**
 * What a stored take records in its `mode` field. It conflates two things: the
 * MEMS channel selection, or the literal "computer" when the take came from the
 * computer microphone. Kept as-is because it is written into IndexedDB and into
 * the exported CSV manifest, so changing it would break existing data.
 */
export type RecordedMode = ChannelMode | "computer";

/** The selected input and its connection status. */
export const device = {
  sourceId: "mems" as SourceId,
  transport: "usb" as Transport,
  /** True once the transport is open and streaming is possible. */
  connected: false,
};

/** Live capture settings, flags and buffers. */
export const capture = {
  /** True between startRecording() and stopRecording(). */
  recording: false,
  /**
   * Doubles as a source marker: setInputSource writes the literal "computer"
   * here when the computer mic is selected. Typed honestly rather than as
   * ChannelMode, which the value routinely violated.
   */
  channelMode: "stereo" as RecordedMode,

  /** Blocks accumulated for the take in progress, concatenated on save. */
  chunks: [] as Int16Array[],
  /** Frames (sample pairs in stereo) captured so far — drives the duration. */
  frames: 0,
  /** Raw sample values captured so far, i.e. frames x channels. */
  values: 0,
  /** Rolling window feeding the live monitors, capped at MAX_LIVE_SAMPLES. */
  live: [] as number[],
  /**
   * Frames to discard at the start of a take. The ESP32 resets as the USB port
   * opens, so the first fraction of a second is a power-on thump. Zero on
   * Wi-Fi and the computer mic.
   */
  warmupFrames: 0,

  /**
   * Exam context for the take in progress: handed in at startRecording() and
   * consumed once on save. Scoped to a single take, unlike the shared global it
   * replaces — nothing outside the capture path can retarget it mid-recording,
   * and a take cannot inherit the previous patient.
   */
  pendingMeta: null as RecordingMeta | null,
  /**
   * When ON the cleanup chain is baked into the stored take; when OFF the raw
   * signal is stored. Legacy code still reads this as the global
   * `noiseAttenuatorEnabled`, wired up in bridge.ts.
   */
  noiseFilterEnabled: false,
};


/** One stored take. Mirrors the IndexedDB "recordings" schema. */
export interface Recording {
  id: number;
  number: number;
  frames: number;
  values: number;
  duration: number;
  channels: number;
  mode: RecordedMode;
  source: string;
  createdAt: Date | string;
  /** Mono, de-interleaved copy used for FFT and feature extraction. */
  analysisSamples: Int16Array;
  /** Interleaved capture, dropped on reload to save memory. */
  samples: Int16Array | null;
  blob: Blob;
  /** Object URL for the <audio> player and the download link. */
  url: string;
  filtered: boolean;
  features: VoiceFeatures | null;
  meta: RecordingMeta | null;
  name?: string;
}

/** Result of an averaged FFT over a selected region. */
export interface Spectrum {
  frequencies: Float32Array;
  magnitudes: Float32Array;
  fftSize: number;
  sampleRate: number;
  averagedFrames: number;
}

/** Which handle of the analysis selection is being dragged. */
export type DragMode = null | "left" | "right" | "middle";

/** Saved takes for this browser, newest first. */
export const library = {
  recordings: [] as Recording[],
  /** Human-facing counter shown on each card; not the storage key. */
  nextIndex: 1,
};

/** Top-level area: "home" (overview), "rnd" (Record/Analyze/Recordings) or
 *  "clinical". Every read of this asks "is this clinical?", so the third
 *  value needed no other call site to change. */
export const ui = {
  mode: "home" as "rnd" | "clinical" | "home",
};

/** R&D analysis view state. Not used by the clinical mode. */
export const analysis = {
  lastSpectrum: null as Spectrum | null,
  lastSpectrumSourceName: "none",
  /** Selection bounds as fractions of the waveform, 0..1. */
  selectionStart: 0,
  selectionEnd: 1,
  dragMode: null as DragMode,
  /** dBFS reference captured from a silent take, or null when uncalibrated. */
  calibratedNoiseFloorDb: null as number | null,
};
