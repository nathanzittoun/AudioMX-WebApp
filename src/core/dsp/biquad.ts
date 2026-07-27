// Second-order IIR section (RBJ cookbook forms). Pure DSP: one instance carries
// its own delay line, so a chain is just an array of them applied in order.

export type BiquadType = "highpass" | "notch" | "lowpass";

export class BiquadFilter {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    readonly type: BiquadType,
    readonly frequency: number,
    readonly q: number,
    readonly sampleRate: number
  ) {
    this.calculateCoefficients();
  }

  private calculateCoefficients(): void {
    const w0 = 2 * Math.PI * this.frequency / this.sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * this.q);

    // Every branch assigns all six coefficients. The legacy version used
    // separate `if`s, which silently produced NaN for an unrecognised type;
    // a switch makes an unhandled type a compile error instead.
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

    switch (this.type) {
      case "highpass":
        b0 = (1 + cosW0) / 2;
        b1 = -(1 + cosW0);
        b2 = (1 + cosW0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
        break;
      case "notch":
        b0 = 1;
        b1 = -2 * cosW0;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
        break;
      case "lowpass":
        b0 = (1 - cosW0) / 2;
        b1 = 1 - cosW0;
        b2 = (1 - cosW0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
        break;
    }

    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;

    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;

    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}
