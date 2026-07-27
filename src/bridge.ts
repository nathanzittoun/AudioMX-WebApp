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
});
