// File naming and browser downloads. Shared by the R&D library, the clinical
// ZIP export and the FHIR export, which is why it sits on its own rather than
// inside any one of them.

import type { Recording } from "../core/state";

/**
 * Reduce arbitrary text to something safe on every filesystem. Patient ids and
 * custom names reach filenames, so this has to be strict rather than clever.
 */
export function sanitizeForFilename(text: unknown): string {
  return String(text).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * A descriptive base filename: a custom name if set, otherwise
 * PatientID__Session__Test__timestamp for clinical takes, else a generic name.
 * The clinical form matters — an exported take has to be identifiable from its
 * filename alone, once it is out of the app and sitting in someone's folder.
 */
export function recordingBaseName(recording: Recording): string {
  const created = recording.createdAt instanceof Date
    ? recording.createdAt
    : new Date(recording.createdAt);
  const timestamp = created.toISOString().replace(/[:.]/g, "-");

  if (recording.name) {
    return sanitizeForFilename(recording.name) + "_" + timestamp;
  }

  if (recording.meta && recording.meta.patientId) {
    return [
      sanitizeForFilename(recording.meta.patientId),
      sanitizeForFilename(recording.meta.sessionId || "session"),
      sanitizeForFilename(recording.meta.testId || "test"),
      timestamp
    ].join("__");
  }

  return "audiomx_recording_" + recording.number + "_" +
    recording.source.replace(/\s+/g, "_").toLowerCase() + "_" +
    recording.mode + "_" + timestamp;
}

/** Save a URL to disk through a transient anchor. */
export function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
