// IndexedDB adapter for the Storage interface.
//
// Pure persistence: it reads and writes, and does nothing else. The legacy
// db.js also mutated app-wide arrays and called render functions from inside
// its save paths, which is what made storage impossible to swap — and it
// carried three calls to render functions that no longer exist anywhere
// (renderPatientSelect, renderPatientMeta, renderPatientChart), silently
// skipped by `typeof` guards. Those are gone.

import type { Repo, Storage, StoredPatient, StoredRecording } from "./types";

const DB_NAME = "acousticConsole";
const DB_VERSION = 2;
const RECORDING_STORE = "recordings";
const PATIENT_STORE = "patients";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDING_STORE)) {
        db.createObjectStore(RECORDING_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PATIENT_STORE)) {
        db.createObjectStore(PATIENT_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Storage failures must not take the exam down with them: a clinician mid-
 * recording cares more about finishing than about the cache. Reads degrade to
 * empty, writes are logged and dropped — the same tolerance db.js had.
 */
function makeRepo<T extends { id: K }, K extends IDBValidKey>(
  storeName: string,
  label: string
): Repo<T, K> {
  return {
    async list(): Promise<T[]> {
      try {
        const db = await openDb();
        const tx = db.transaction(storeName, "readonly");
        return (await idbRequest<T[]>(tx.objectStore(storeName).getAll())) ?? [];
      } catch (error) {
        console.warn(`Could not load ${label}:`, error);
        return [];
      }
    },

    async get(id: K): Promise<T | null> {
      try {
        const db = await openDb();
        const tx = db.transaction(storeName, "readonly");
        return (await idbRequest<T | undefined>(tx.objectStore(storeName).get(id))) ?? null;
      } catch (error) {
        console.warn(`Could not read ${label}:`, error);
        return null;
      }
    },

    async put(item: T): Promise<void> {
      try {
        const db = await openDb();
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(item);
        await idbTransaction(tx);
      } catch (error) {
        console.warn(`Could not persist ${label}:`, error);
      }
    },

    async remove(id: K): Promise<void> {
      try {
        const db = await openDb();
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(id);
        await idbTransaction(tx);
      } catch (error) {
        console.warn(`Could not delete ${label}:`, error);
      }
    },

    async clear(): Promise<void> {
      try {
        const db = await openDb();
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        await idbTransaction(tx);
      } catch (error) {
        console.warn(`Could not clear ${label}:`, error);
      }
    },
  };
}

export function createIndexedDbStorage(): Storage {
  return {
    recordings: makeRepo<StoredRecording, number>(RECORDING_STORE, "recordings"),
    patients: makeRepo<StoredPatient, string>(PATIENT_STORE, "patients"),
  };
}
