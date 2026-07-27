// The three counters above the live waveform: duration, frames, state.
//
// A leaf like ui/log and ui/status. The ingest path refreshes it on every
// block and the R&D mode buttons refresh it when the channel count changes;
// neither should need the application shell to do so.

import { SAMPLE_RATE } from "../core/constants";
import { capture } from "../core/state";
import { el } from "./dom";

export function updateCurrentStats(): void {
  const duration = capture.frames / SAMPLE_RATE;
  const channelText = capture.channelMode === "stereo" ? "2 channels" : "1 channel";
  const durationBox = el("durationBox");
  const sampleBox = el("sampleBox");
  const recordingStateBox = el("recordingStateBox");
  if (durationBox) durationBox.textContent = "Duration: " + duration.toFixed(2) + " s";
  if (sampleBox) sampleBox.textContent = "Frames: " + capture.frames + " · " + channelText;
  if (recordingStateBox) recordingStateBox.textContent = capture.recording ? "Recording" : "Idle";
}
