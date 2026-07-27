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

/** Which microphone is selected, and how it is attached. */
export type SourceId = "mems" | "computer";
/** How the MEMS device is reached. Meaningless when sourceId is "computer". */
export type Transport = "usb" | "wifi";
/** Which of the two MEMS channels ends up in the stored take. */
export type ChannelMode = "stereo" | "left" | "right";

/** The selected input and its connection status. */
export const device = {
  sourceId: "mems" as SourceId,
  transport: "usb" as Transport,
  /** True once the transport is open and streaming is possible. */
  connected: false,
};

/** Live capture settings and flags. */
export const capture = {
  /** True between startRecording() and stopRecording(). */
  recording: false,
  channelMode: "stereo" as ChannelMode,
  /**
   * When ON the cleanup chain is baked into the stored take; when OFF the raw
   * signal is stored. Legacy code still reads this as the global
   * `noiseAttenuatorEnabled`, wired up in bridge.ts.
   */
  noiseFilterEnabled: false,
};
