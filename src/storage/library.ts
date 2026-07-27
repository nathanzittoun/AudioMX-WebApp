// Orchestration between the storage adapter and the in-memory library.
//
// This is the half of the old db.js that was never really persistence: loading
// takes back into memory, minting object URLs, refreshing the views. Keeping it
// out of the adapter is what lets the adapter be swapped.

import { library, type Recording } from "../core/state";
import { storage } from "./index";
import type { StoredPatient, StoredRecording } from "./types";

export async function savePatient(patient: StoredPatient): Promise<void> {
  await storage.patients.put({
    id: patient.id,
    name: patient.name || "",
    age: patient.age || "",
    sex: patient.sex || "",
    createdAt: patient.createdAt,
  });
}

export const deletePatient = (id: string): Promise<void> => storage.patients.remove(id);
export const loadPatients = (): Promise<StoredPatient[]> => storage.patients.list();

export async function saveRecording(recording: Recording): Promise<void> {
  // Only the persisted fields — `url` is an object URL valid for this document
  // and `samples` is dropped to keep the database small.
  await storage.recordings.put({
    id: recording.id,
    number: recording.number,
    frames: recording.frames,
    values: recording.values,
    duration: recording.duration,
    channels: recording.channels,
    mode: recording.mode,
    source: recording.source,
    createdAt: recording.createdAt,
    analysisSamples: recording.analysisSamples,
    blob: recording.blob,
    filtered: recording.filtered || false,
    features: recording.features ?? null,
    meta: recording.meta ?? null,
    name: recording.name ?? null,
  });
}

export const deleteRecording = (id: number): Promise<void> => storage.recordings.remove(id);

function hydrate(stored: StoredRecording): Recording {
  return {
    id: stored.id,
    number: stored.number,
    frames: stored.frames,
    values: stored.values,
    duration: stored.duration,
    channels: stored.channels,
    mode: stored.mode,
    source: stored.source,
    samples: null,
    analysisSamples: stored.analysisSamples,
    blob: stored.blob,
    url: URL.createObjectURL(stored.blob),
    filtered: stored.filtered || false,
    features: stored.features ?? null,
    meta: stored.meta ?? null,
    name: stored.name ?? undefined,
    createdAt: stored.createdAt instanceof Date ? stored.createdAt : new Date(stored.createdAt),
  };
}

/** Rebuild the in-memory library from storage and refresh the views. */
export async function restoreRecordings(): Promise<void> {
  const stored = await storage.recordings.list();
  if (!stored.length) return;

  stored.sort((a, b) => a.number - b.number);

  let maxNumber = 0;
  for (const s of stored) {
    // Newest first: `stored` is ascending by number, so unshift each.
    library.recordings.unshift(hydrate(s));
    if (s.number > maxNumber) maxNumber = s.number;
  }
  library.nextIndex = maxNumber + 1;

  renderRecordings();
  updateAnalysisSourceSelect();
  // The patient list and chart are derived from recordings, so they only
  // become correct once the takes are back.
  loadClinicalPatients();

  log("Restored " + stored.length + " saved recording(s) from this browser.");
}

/**
 * Wipe both stores and the in-memory state. Deliberately does not ask for
 * confirmation — that belongs to whatever control the clinician clicked.
 */
export async function clearAllData(): Promise<void> {
  await storage.recordings.clear();
  await storage.patients.clear();

  for (const r of library.recordings) {
    try { URL.revokeObjectURL(r.url); } catch (e) { /* already revoked */ }
  }

  library.recordings = [];
  library.nextIndex = 1;

  clinicalPatients = [];
  currentPatient = null;
  currentSessionId = null;

  renderRecordings();
  updateAnalysisSourceSelect();
  renderPatientTable();
  renderExamHeader();
  renderChart();

  log("All patients and recordings cleared.");
}
