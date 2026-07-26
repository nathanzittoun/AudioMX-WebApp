// IndexedDB persistence for saved recordings, so a page refresh (or a crash)
// doesn't wipe a session. We store the raw WAV blob, the optional filtered
// blob, the analysis samples, and the metadata. Blobs and typed arrays survive
// IndexedDB's structured clone directly.

const DB_NAME = "acousticConsole";
const DB_VERSION = 2;
const DB_STORE = "recordings";
const PATIENT_STORE = "patients";

function openRecordingsDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PATIENT_STORE)) {
        db.createObjectStore(PATIENT_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePatientToDb(patient) {
  try {
    const db = await openRecordingsDb();
    const tx = db.transaction(PATIENT_STORE, "readwrite");
    tx.objectStore(PATIENT_STORE).put({
      id: patient.id,
      name: patient.name || "",
      age: patient.age || "",
      sex: patient.sex || "",
      createdAt: patient.createdAt
    });
    await idbTransaction(tx);
  } catch (error) {
    console.warn("Could not persist patient:", error);
  }
}

async function deletePatientFromDb(id) {
  try {
    const db = await openRecordingsDb();
    const tx = db.transaction(PATIENT_STORE, "readwrite");
    tx.objectStore(PATIENT_STORE).delete(id);
    await idbTransaction(tx);
  } catch (error) {
    console.warn("Could not delete patient:", error);
  }
}

// Wipe every recording and patient — persisted store and in-memory state.
async function clearAllData() {
  if (!confirm("Delete ALL patients and ALL recordings from this browser? This cannot be undone.")) {
    return;
  }

  try {
    const db = await openRecordingsDb();
    const tx = db.transaction([DB_STORE, PATIENT_STORE], "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.objectStore(PATIENT_STORE).clear();
    await idbTransaction(tx);
  } catch (error) {
    console.warn("Could not clear stored data:", error);
  }

  for (const r of recordings) {
    try {
      URL.revokeObjectURL(r.url);
    } catch (e) {
      // ignore
    }
  }

  recordings = [];
  recordingIndex = 1;

  if (typeof clinicalPatients !== "undefined") clinicalPatients = [];
  if (typeof currentPatient !== "undefined") currentPatient = null;
  if (typeof currentSessionId !== "undefined") currentSessionId = null;

  renderRecordings();
  updateAnalysisSourceSelect();
  if (typeof renderPatientSelect === "function") renderPatientSelect();
  if (typeof renderPatientMeta === "function") renderPatientMeta();
  if (typeof renderPatientChart === "function") renderPatientChart();

  log("All patients and recordings cleared.");
}

async function loadPatientsFromDb() {
  try {
    const db = await openRecordingsDb();
    const tx = db.transaction(PATIENT_STORE, "readonly");
    const all = await idbRequest(tx.objectStore(PATIENT_STORE).getAll());
    return all || [];
  } catch (error) {
    console.warn("Could not load patients:", error);
    return [];
  }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function saveRecordingToDb(recording) {
  try {
    const db = await openRecordingsDb();
    const tx = db.transaction(DB_STORE, "readwrite");

    tx.objectStore(DB_STORE).put({
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
      features: recording.features || null,
      meta: recording.meta || null,
      name: recording.name || null
    });

    await idbTransaction(tx);
  } catch (error) {
    console.warn("Could not persist recording:", error);
  }
}

async function deleteRecordingFromDb(id) {
  try {
    const db = await openRecordingsDb();
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    await idbTransaction(tx);
  } catch (error) {
    console.warn("Could not delete persisted recording:", error);
  }
}

async function loadRecordingsFromDb() {
  try {
    const db = await openRecordingsDb();
    const tx = db.transaction(DB_STORE, "readonly");
    const all = await idbRequest(tx.objectStore(DB_STORE).getAll());
    return all || [];
  } catch (error) {
    console.warn("Could not load persisted recordings:", error);
    return [];
  }
}

// Rebuild the in-memory recordings from IndexedDB and render them. Called once
// on startup.
async function restoreRecordings() {
  const stored = await loadRecordingsFromDb();

  if (!stored.length) {
    return;
  }

  stored.sort((a, b) => a.number - b.number);

  let maxNumber = 0;

  for (const s of stored) {
    const url = URL.createObjectURL(s.blob);

    const recording = {
      id: s.id,
      number: s.number,
      frames: s.frames,
      values: s.values,
      duration: s.duration,
      channels: s.channels,
      mode: s.mode,
      source: s.source,
      samples: null,
      analysisSamples: s.analysisSamples,
      blob: s.blob,
      url,
      filtered: s.filtered || false,
      features: s.features || null,
      meta: s.meta || null,
      name: s.name || null,
      createdAt: s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt)
    };

    // Newest first: stored is ascending by number, so unshift each.
    recordings.unshift(recording);

    if (s.number > maxNumber) {
      maxNumber = s.number;
    }
  }

  recordingIndex = maxNumber + 1;

  renderRecordings();
  updateAnalysisSourceSelect();

  // Refresh the clinical patient list/chart now that recordings are loaded.
  if (typeof loadClinicalPatients === "function") loadClinicalPatients();

  log("Restored " + stored.length + " saved recording(s) from this browser.");
}
