// The single path audio takes into a recording.
//
// Every transport used to bring its own copy of this: audio.js had addSamples()
// for the MEMS stream, and computerMic.js re-implemented the same buffering,
// filtering, live-window and stats logic in addComputerMicSamples(). Two copies
// of the ingest path means a fix to one — a filter change, a counter, the
// warm-up skip — silently misses the other. There is one now, and each source
// only has to hand it samples.

import { MAX_LIVE_SAMPLES, SAMPLE_RATE } from "./constants";
import { encodeWav, makeAnalysisSamples, mergeChunks } from "./wav";
import { extractVoiceFeatures, type VoiceFeatures } from "./features";
import { saveRecording } from "../storage/library";
import { capture, device, library, type ChannelMode, type Recording } from "./state";
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

/**
 * Close out the take in progress: flatten it, encode a WAV, extract features,
 * file it in the library and persist it.
 *
 * The WAV is written at SAMPLE_RATE, which is the rate every source is
 * normalised to — computerMic.js resamples when the browser hands it another.
 * A mismatch here is what made takes play back in slow motion.
 */
export function saveCurrentRecording(): void {
  const stereo = capture.channelMode === "stereo" && device.sourceId === "mems";
  const numChannels = stereo ? 2 : 1;

  const samples = mergeChunks(capture.chunks, capture.values);
  const analysisSamples = makeAnalysisSamples(samples, stereo ? "stereo" : "left");
  const blob = new Blob([encodeWav(samples, SAMPLE_RATE, numChannels)], { type: "audio/wav" });
  const sourceLabel = device.sourceId === "mems" ? "MEMS" : "Computer mic";

  // Feature extraction is a research preview and must never cost a take: a
  // failure here would otherwise lose audio that cannot be recorded again.
  let features: VoiceFeatures | null = null;
  try {
    features = extractVoiceFeatures(analysisSamples, SAMPLE_RATE);
  } catch (e) {
    console.warn("Feature extraction failed:", e);
  }

  const recording: Recording = {
    id: Date.now(),
    number: library.nextIndex++,
    frames: capture.frames,
    values: capture.values,
    duration: capture.frames / SAMPLE_RATE,
    channels: numChannels,
    mode: device.sourceId === "mems" ? capture.channelMode : "computer",
    source: sourceLabel,
    samples,
    analysisSamples,
    blob,
    url: URL.createObjectURL(blob),
    // One audio per take: already filtered if the noise filter was ON during
    // capture, raw if it was OFF. No duplicate copy.
    filtered: capture.noiseFilterEnabled,
    features,
    meta: capture.pendingMeta,
    createdAt: new Date(),
  };

  // Consumed: the next take must not inherit this one's patient.
  capture.pendingMeta = null;

  library.recordings.unshift(recording);

  renderRecordings();
  updateAnalysisSourceSelect();

  // Best-effort and non-blocking: the take is already in memory and on screen.
  void saveRecording(recording);

  // Let the clinical view refresh its session review if this was an exam take.
  if (recording.meta && typeof onClinicalRecordingSaved === "function") {
    onClinicalRecordingSaved(recording);
  }

  log("Recording " + recording.number + " saved from " + sourceLabel + ".");
}
