// Runs BEFORE every legacy script in public/legacy/.
//
// During the migration the app lives in two worlds: ES modules under src/, and
// classic scripts sharing one global scope under public/legacy/. This file is
// the seam. As each legacy file is converted it moves to src/ and re-exports
// its symbols here, which publishes them on `globalThis` so the not-yet-
// converted files keep finding them exactly where they always were.
//
// Ordering is what makes this work: module scripts and deferred classic scripts
// both run after parsing, in document order. This tag is placed first in
// index.html so every symbol is installed before any legacy code executes —
// which matters because some legacy files read globals at load time, not just
// inside functions.
//
// This file shrinks with every conversion and is deleted once public/legacy/
// is empty.

import { showTab } from "./ui/tabs";
import { extractVoiceFeatures, formatFeatures } from "./core/features";
import { createZip } from "./core/zip";
import { PROTOCOL_TESTS, getProtocolTest } from "./core/protocol";
import { capture } from "./core/state";
import {
  resetNoiseAttenuator,
  processNoiseAttenuator,
  applyFilterOffline,
} from "./core/dsp/noiseFilter";
import { toggleNoiseAttenuator } from "./rnd/noiseToggle";

// `noiseAttenuatorEnabled` is state, not a function, and app.js/audio.js/
// computerMic.js both read AND write it. An accessor keeps the single source of
// truth in state.ts while legacy assignments still work.
//
// This only functions because the `let noiseAttenuatorEnabled` was deleted from
// app.js in the same commit: a top-level `let` is a global *lexical* binding,
// and it would shadow this property entirely — legacy code would keep using its
// own copy and the two would silently drift apart.
Object.defineProperty(globalThis, "noiseAttenuatorEnabled", {
  get: () => capture.noiseFilterEnabled,
  set: (v: boolean) => { capture.noiseFilterEnabled = v; },
  configurable: true,
});

Object.assign(globalThis, {
  // audio.js -> analyzeRecording() jumps to the analyse view.
  showTab,
  // audio.js stamps features onto a take; clinical.js renders them in the chart.
  extractVoiceFeatures,
  formatFeatures,
  // clinical.js -> exportRecordingsZip() packs a session as one download.
  createZip,
  // clinical.js drives the exam from the test list and looks tests up by id.
  PROTOCOL_TESTS,
  getProtocolTest,
  // app.js resets the chain per take; audio.js and computerMic.js run samples
  // through it on the way into the buffer.
  resetNoiseAttenuator,
  processNoiseAttenuator,
  applyFilterOffline,
  toggleNoiseAttenuator,
});
