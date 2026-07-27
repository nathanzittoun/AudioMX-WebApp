// Radix-2 FFT and the framing that feeds it. Pure: no DOM, no shared state.

export function nextPowerOfTwo(value: number): number {
  let power = 1;

  while (power < value) {
    power *= 2;
  }

  return power;
}

export function hannWindow(n: number, N: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
}

/** In-place iterative radix-2 FFT. `real` and `imag` must be the same length. */
export function fftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length;

  let j = 0;

  for (let i = 1; i < n; i++) {
    let bit = n >> 1;

    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }

    j ^= bit;

    if (i < j) {
      const tempReal = real[i];
      const tempImag = imag[i];

      real[i] = real[j];
      imag[i] = imag[j];

      real[j] = tempReal;
      imag[j] = tempImag;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wLenReal = Math.cos(angle);
    const wLenImag = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wReal = 1;
      let wImag = 0;

      for (let k = 0; k < len / 2; k++) {
        const uReal = real[i + k];
        const uImag = imag[i + k];

        const vReal =
          real[i + k + len / 2] * wReal -
          imag[i + k + len / 2] * wImag;

        const vImag =
          real[i + k + len / 2] * wImag +
          imag[i + k + len / 2] * wReal;

        real[i + k] = uReal + vReal;
        imag[i + k] = uImag + vImag;

        real[i + k + len / 2] = uReal - vReal;
        imag[i + k + len / 2] = uImag - vImag;

        const nextWReal = wReal * wLenReal - wImag * wLenImag;
        const nextWImag = wReal * wLenImag + wImag * wLenReal;

        wReal = nextWReal;
        wImag = nextWImag;
      }
    }
  }
}

/**
 * Window one N-sample frame starting at `start`, transform it, and add its
 * power into `accumulatedPower`. Frames past the end of the signal are
 * zero-padded.
 */
export function accumulateFftFrame(
  samples: ArrayLike<number>,
  start: number,
  N: number,
  accumulatedPower: Float64Array
): void {
  const real = new Float32Array(N);
  const imag = new Float32Array(N);

  let mean = 0;

  for (let i = 0; i < N; i++) {
    const index = start + i;
    const value = index < samples.length ? samples[index] : 0;
    mean += value;
  }

  mean /= N;

  for (let i = 0; i < N; i++) {
    const index = start + i;
    const value = index < samples.length ? samples[index] : 0;

    real[i] = (value - mean) * hannWindow(i, N);
    imag[i] = 0;
  }

  fftRadix2(real, imag);

  const binCount = Math.floor(N / 2);

  // Accumulate power (|X[k]|^2). Averaging power across overlapping frames is
  // the standard Welch estimate; the amplitude/dB conversion happens once in
  // computeSpectrum after averaging.
  for (let k = 0; k < binCount; k++) {
    accumulatedPower[k] += real[k] * real[k] + imag[k] * imag[k];
  }
}
