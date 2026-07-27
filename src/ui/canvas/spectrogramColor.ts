// Magnitude-to-colour ramp for the spectrograms: dark blue through purple and
// orange to near-white. Pure, but a presentation choice rather than DSP.

type Stop = readonly [t: number, r: number, g: number, b: number];

const STOPS: readonly Stop[] = [
  [0.0, 8, 8, 22],
  [0.3, 45, 22, 110],
  [0.55, 150, 32, 90],
  [0.75, 228, 90, 40],
  [0.9, 250, 190, 60],
  [1.0, 255, 255, 220],
];

/** `t` is 0..1; values outside are clamped. Returns [r, g, b]. */
export function spectrogramColor(t: number): [number, number, number] {
  if (t < 0) t = 0;
  if (t > 1) t = 1;

  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const f = (t - a[0]) / (b[0] - a[0]);
      return [
        Math.round(a[1] + f * (b[1] - a[1])),
        Math.round(a[2] + f * (b[2] - a[2])),
        Math.round(a[3] + f * (b[3] - a[3])),
      ];
    }
  }

  return [255, 255, 220];
}
