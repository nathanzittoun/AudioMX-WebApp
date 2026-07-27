// Rate conversion for capture sources whose native rate is not SAMPLE_RATE.
//
// Averages over one output period before decimating. Picking the nearest sample
// instead would fold everything above 8 kHz back into the voice band, which
// corrupts exactly the measurements this device exists to make — jitter, HNR
// and formants are all defined on the spectrum below that.
//
// Stateful on purpose: the fractional cursor and the averaging window have to
// stay continuous across buffer boundaries, or every block edge becomes a
// discontinuity the FFT reads as broadband noise.

export interface Resampler {
  /** Convert one block. Returns fewer or more samples than it was given. */
  process(input: Float32Array, inRate: number, outRate: number): number[];
  /** Drop carried state. Call when a new capture starts. */
  reset(): void;
}

export function createResampler(): Resampler {
  let carry: Float32Array | null = null;
  let cursor = 0;

  return {
    reset(): void {
      carry = null;
      cursor = 0;
    },

    process(input: Float32Array, inRate: number, outRate: number): number[] {
      const ratio = inRate / outRate;
      const half = ratio > 1 ? ratio / 2 : 0.5;
      const pad = Math.ceil(half) + 1;

      // Splice the previous block's tail in front, so the averaging window
      // never runs off the start of the buffer and invents a discontinuity.
      const carryLen = carry ? carry.length : 0;
      const buf = new Float32Array(carryLen + input.length);
      if (carry) buf.set(carry, 0);
      buf.set(input, carryLen);

      // Stop short of the end: those samples need the next block to average over.
      const limit = buf.length - pad;
      const out: number[] = [];
      let pos = cursor + carryLen;

      while (pos < limit) {
        const from = Math.max(0, Math.ceil(pos - half));
        const to = Math.min(buf.length - 1, Math.floor(pos + half));
        let sum = 0;
        for (let i = from; i <= to; i++) sum += buf[i];
        out.push(to >= from ? sum / (to - from + 1) : 0);
        pos += ratio;
      }

      const keep = Math.min(buf.length, pad * 2);
      carry = buf.slice(buf.length - keep);
      cursor = pos - (buf.length - keep);
      return out;
    },
  };
}
