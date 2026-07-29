// The canvas half of the palette.
//
// A 2D context cannot read a CSS custom property, so every colour drawn into a
// canvas has to exist a second time in TypeScript. Keeping that second copy in
// one module is what stops the two halves of the interface drifting apart:
// these values mirror the tokens at the top of style.css and must move with
// them.
//
// In the 1A language a plot is a dark surface. Every one of them — live
// waveform, live spectrum, FFT, selection, spectrogram, clinical monitors —
// draws on --plot-bg, so the colours below are the whole of it rather than one
// hard-coded grey per drawing function, which is what they replaced.

export const PLOT = {
  /** The plot surface itself. Matches --plot-bg. */
  bg: "#0e1420",

  /** Grid lines and the zero axis. Matches --plot-grid. */
  grid: "#243040",

  /** The zero line, one step brighter than the grid so it reads as the axis
   *  rather than as another gridline. */
  axis: "#33455c",

  /** Axis labels and units, on the dark surface. */
  label: "#6d7a8a",

  /** The measured signal itself: waveform and spectrum traces. Light blue,
   *  which is the only colour with any weight on a surface this dark. */
  trace: "#5b9be0",

  /** Bars of a spectrum, brightest at the front. */
  bar: "#4a86c9",

  /** Wash over the region chosen for analysis, and the handles that bound it.
   *  Excluded audio is dimmed separately; this only tints. */
  selection: "rgba(91, 155, 224, 0.14)",
  selectionEdge: "#5b9be0",

  /** Dimming applied to audio *outside* the selection. Black on a dark surface
   *  would be invisible, so this darkens toward the ground rather than toward
   *  transparency. */
  excluded: "rgba(4, 7, 10, 0.55)",
} as const;
