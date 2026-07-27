// The storage contract.
//
// Everything the app persists goes through this interface, so the IndexedDB
// adapter can be swapped for a REST-backed one without the rest of the app
// noticing. That swap is the whole point: IndexedDB lives inside one browser on
// one machine, which is exactly why a patient seen by clinicians at different
// hospitals cannot be found today.
//
// Deliberately narrow. Anything specific to IndexedDB — transactions, key
// paths, structured clone — stays inside the adapter.

import type { RecordedMode, RecordingMeta } from "../core/state";
import type { VoiceFeatures } from "../core/features";

/**
 * Where a take's audio actually lives.
 *
 * The indirection exists from the start on purpose: IndexedDB holds the bytes
 * inline, a server will hand back a URL instead. Retrofitting this later would
 * mean migrating recordings that by then contain real patient audio.
 */
export type AudioRef =
  | { kind: "blob"; blob: Blob }
  | { kind: "url"; url: string; bytes?: number };

/** A take as persisted. Mirrors the IndexedDB "recordings" schema (v2). */
export interface StoredRecording {
  id: number;
  number: number;
  frames: number;
  values: number;
  duration: number;
  channels: number;
  mode: RecordedMode;
  source: string;
  createdAt: Date | string;
  analysisSamples: Int16Array;
  blob: Blob;
  filtered: boolean;
  features: VoiceFeatures | null;
  meta: RecordingMeta | null;
  name: string | null;
}

/** A patient as persisted. Demographics only — takes reference it by id. */
export interface StoredPatient {
  id: string;
  name: string;
  age: string;
  sex: string;
  createdAt: Date | string;
}

/** CRUD over one collection. */
export interface Repo<T, K = string> {
  list(): Promise<T[]>;
  get(id: K): Promise<T | null>;
  put(item: T): Promise<void>;
  remove(id: K): Promise<void>;
  clear(): Promise<void>;
}

export interface Storage {
  readonly recordings: Repo<StoredRecording, number>;
  readonly patients: Repo<StoredPatient, string>;
}
