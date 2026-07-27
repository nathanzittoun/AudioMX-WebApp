// WAV assembly and the buffer handling around it. Pure: give it samples, get
// bytes back. No DOM, no shared state, so it is testable on its own.

import type { ChannelMode } from "./state";

/**
 * Mono copy for FFT and feature extraction. A stereo take is mixed down; the
 * stored WAV keeps both channels. Analysis is mono by design — the biomarker
 * measures are defined on a single voice signal, not a stereo image.
 */
export function makeAnalysisSamples(samples: Int16Array, mode: ChannelMode): Int16Array {
  if (mode !== "stereo") {
    return Int16Array.from(samples);
  }

  const frameCount = Math.floor(samples.length / 2);
  const mono = new Int16Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    const right = samples[i * 2];
    const left = samples[i * 2 + 1];
    mono[i] = Math.round((right + left) / 2);
  }

  return mono;
}

/** Flatten the blocks accumulated during a take into one contiguous buffer. */
export function mergeChunks(chunks: Int16Array[], totalValues: number): Int16Array {
  const samples = new Int16Array(totalValues);
  let offset = 0;

  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  return samples;
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * 16-bit PCM WAV. `sampleRate` is written into the header, so it must be the
 * rate the samples were actually captured at — a mismatch plays the take back
 * at the wrong speed and silently corrupts every duration derived from it.
 */
export function encodeWav(
  samples: Int16Array,
  sampleRate: number,
  numChannels: number
): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);   // fmt chunk size
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);   // bits per sample

  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i], true);
    offset += 2;
  }

  return buffer;
}
