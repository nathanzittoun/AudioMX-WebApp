// The canvas half of the palette.
//
// A 2D context cannot read a CSS custom property, so every colour drawn into a
// canvas has to exist a second time in TypeScript. Keeping that second copy in
// one module is what stops the two halves of the interface drifting apart:
// these values mirror the tokens at the top of style.css and must move with
// them.

export const PLOT = {
  /** The measured signal itself: waveform and spectrum traces. Brand blue —
   *  red is reserved for capture in progress, errors and destructive actions,
   *  and a trace is none of those. */
  trace: "#2f5a8c",

  /** Wash over the region chosen for analysis. Excluded audio is dimmed
   *  separately, which is what actually separates the two; this only tints. */
  selection: "rgba(74, 130, 190, 0.18)",
} as const;
