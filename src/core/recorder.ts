// The single path audio takes into a recording.
//
// Every transport used to bring its own copy of this: audio.js had addSamples()
// for the MEMS stream, and computerMic.js re-implemented the same buffering,
// filtering, live-window and stats logic in addComputerMicSamples(). Two copies
// of the ingest path means a fix to one — a filter change, a counter, the
// warm-up skip — silently misses the other. There is one now, and each source
// only has to hand it samples.

import { MAX_LIVE_SAMPLES } from "./constants";
import { capture, type ChannelMode } from "./state";
import { processNoiseAttenuator } from "./dsp/noiseFilter";

/**
 * Take one block of interleaved samples into the recording in progress.
 * `channels` is 2 for a stereo MEMS take, 1 otherwise.
 */
export function ingest(samples: Int16Array, channels: 1 | 2): void {
  if (!capture.recording) return;

  const frameCount = samples.length / channels;

  // Skip the power-on transient at the start of a USB take. Zero elsewhere, so
  // this is a no-op for Wi-Fi and the computer mic.
  if (capture.warmupFrames > 0) {
    capture.warmupFrames -= frameCount;
    return;
  }

  // With the filter ON the cleanup is baked into the stored audio (one file);
  // OFF stores the raw capture. Biomarker analysis wants the raw signal.
  const stored = capture.noiseFilterEnabled
    ? processNoiseAttenuator(samples, channels)
    : samples;

  // The live monitors are mono, so a stereo take is mixed down for display
  // only — the stored audio keeps both channels.
  for (let i = 0; i < frameCount; i++) {
    capture.live.push(
      channels === 2
        ? Math.round((stored[i * 2] + stored[i * 2 + 1]) / 2)
        : stored[i]
    );
  }

  capture.chunks.push(stored);
  capture.frames += frameCount;
  capture.values += stored.length;

  if (capture.live.length > MAX_LIVE_SAMPLES) {
    capture.live = capture.live.slice(capture.live.length - MAX_LIVE_SAMPLES);
  }

  updateCurrentStats();
  renderLiveMonitors();
}

/**
 * Decode one MEMS frame — pairs of little-endian int16, right channel first,
 * matching the firmware's I2S order — and apply the selected channel mode.
 */
export function ingestMemsFrame(payloadBytes: Uint8Array): void {
  if (!capture.recording) return;

  const view = new DataView(
    payloadBytes.buffer,
    payloadBytes.byteOffset,
    payloadBytes.byteLength
  );

  const frameCount = payloadBytes.byteLength / 4;
  const mode: ChannelMode = capture.channelMode;
  const stereo = mode === "stereo";

  const out = new Int16Array(stereo ? frameCount * 2 : frameCount);

  for (let i = 0; i < frameCount; i++) {
    const right = view.getInt16(i * 4, true);
    const left = view.getInt16(i * 4 + 2, true);

    if (stereo) {
      out[i * 2] = right;
      out[i * 2 + 1] = left;
    } else if (mode === "left") {
      out[i] = left;
    } else {
      out[i] = right;
    }
  }

  ingest(out, stereo ? 2 : 1);
}
