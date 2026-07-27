// Level conversions shared by the meters, the FFT axis and the spectrogram.

/** Signed 16-bit magnitude to dBFS, floored at -120 for silence. */
export function dbfs(value: number): number {
  if (value <= 0) {
    return -120;
  }

  return 20 * Math.log10(value / 32768);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Map dBFS onto a 0-100 meter, with -80 dBFS as the bottom of the scale. */
export function dbToBar(db: number): number {
  return clamp(((db + 80) / 80) * 100, 0, 100);
}

/**
 * Single-bin DFT via Goertzel — far cheaper than a full FFT when only one
 * frequency matters, which is why the 60/120 Hz hum meters use it.
 */
export function goertzelMagnitude(
  samples: ArrayLike<number>,
  targetFreq: number,
  sampleRate: number
): number {
  const n = samples.length;

  if (n === 0) {
    return 0;
  }

  // Remove DC first: a MEMS mic bias would otherwise leak energy into the
  // low bins and inflate the 60/120 Hz readings.
  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += samples[i];
  }
  mean /= n;

  const k = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);

  let s0 = 0;
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < n; i++) {
    s0 = (samples[i] - mean) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;

  // |X[k]| for a single Goertzel bin is A*n/2 for a tone of amplitude A, so
  // divide by n and apply the one-sided factor of 2 to read back the tone
  // amplitude. This keeps the hum meters on the same scale as the FFT.
  return (2 * Math.sqrt(Math.max(power, 0))) / n;
}
