// Clinical section — organized like a small clinical app:
//   • Patients tab: a searchable patient database.
//   • Exam tab: run the protocol for the selected patient (live monitors,
//     connect state, quality gate, patient prompt + pop-out).
//   • Chart tab: the patient's sessions as collapsible folders of takes.
// Takes are filed under the patient/session, kept here (not the R&D Library),
// and persisted in IndexedDB.

import { PROTOCOL_TESTS, getProtocolTest, type PatientMessage, type ProtocolTest } from "./core/protocol";
import { SAMPLE_RATE } from "./core/constants";
import { capture, device, library, ui, type Recording, type RecordingMeta } from "./core/state";
import { clamp, dbfs } from "./core/dsp/levels";
import { computeSpectrum } from "./core/dsp/spectrum";
import { audioContext } from "./core/audioContext";
import { on } from "./core/bus";
import { formatFeatures, type VoiceFeatures } from "./core/features";
import { createZip, type ZipFile } from "./core/zip";
import { connectSerial } from "./device/serialSource";
import { connectWifiMems } from "./device/wifiSource";
import { connectComputerMic } from "./device/computerMicSource";
import { downloadPatientFhir } from "./ehr/fhirExport";
// deleteRecording comes from libraryView, NOT from storage. The two shared the
// name `deleteRecording` as globals and bridge.ts published the libraryView one:
// it revokes the object URL, drops the take from library.recordings, refreshes
// the R&D views and only then removes it from IndexedDB. Importing the storage
// function instead would delete the row and leave the take on screen until a
// reload.
import {
  analyzeRecording, deleteRecording, downloadRecording, renameRecording,
} from "./rnd/libraryView";
import { deletePatient as deletePatientFromDb, loadPatients, savePatient } from "./storage/library";
import type { StoredPatient } from "./storage/types";
import { el, requireEl } from "./ui/dom";
import { reflectNav } from "./ui/nav";
import { PLOT } from "./ui/theme";
import { recordingBaseName, sanitizeForFilename, triggerDownload } from "./ui/download";
import { setAppMode, setInputSource, startRecording, stopRecording } from "./app";
import { log } from "./ui/log";
import { setStatus } from "./ui/status";

/** How the clinician attached a microphone for this exam. */
type ConnectKind = "usb" | "wifi" | "computer";

/**
 * Where the exam is in its cycle.
 *
 * "waiting" is the state between pressing Start and the patient confirming
 * "I'm ready"; the countdown ("ready") only begins after that. It was missing
 * from the informal comment this replaces, even though three call sites test
 * for it — writing the union down is what made that visible.
 */
type ClinicalPhase = "idle" | "waiting" | "ready" | "recording";

/** Level/peak/clipping summary of a block of samples. */
interface ClinicalMetrics {
  rms: number;
  peak: number;
  clip: number;
}

/** One session of a patient: its takes, in order, and when it started. */
export interface PatientSession {
  id: string;
  number: number;
  takes: Recording[];
  date: Date;
}

let clinicalPatients: StoredPatient[] = [];
let currentPatient: StoredPatient | null = null;
let currentSessionId: string | null = null;
let clinicalNotes = "";
let clinicalCurrentTest: ProtocolTest = PROTOCOL_TESTS[0];
let clinicalConnectKind: ConnectKind | null = null;
// Exam context for the take being set up. Owned here and handed to
// startRecording(); the capture path no longer reaches back for it.
let activeTestMeta: RecordingMeta | null = null;

let clinicalTimer: number | null = null;
let clinicalTimerStart = 0;
let clinicalTimerDuration = 0;
let lastClinicalRecording: Recording | null = null;

// Seconds of "get ready" countdown shown to the patient before recording.
const READY_SECONDS = 5;

/**
 * The "go" tone: pitch, and how long it sounds.
 *
 * The recording must not contain it. F0, HNR, jitter and shimmer are computed
 * over the whole take, so a fifth of a second of pure 990 Hz sitting at the
 * start does not merely sound wrong — it moves the numbers the exam exists to
 * produce. Capture therefore starts once the tone has finished, and the
 * computer mic additionally drops its pre-roll block, which would otherwise
 * carry the tone back into the take.
 */
const GO_BEEP_HZ = 990;
const GO_BEEP_MS = 220;
let clinicalPhase: ClinicalPhase = "idle";

// Two transports to the pop-out patient window (patient.html): BroadcastChannel
// (same origin) and direct postMessage to the opened window (crosses origins).
const clinicalChannel = "BroadcastChannel" in window ? new BroadcastChannel("audiomx-patient") : null;
let patientWindowRef: Window | null = null;

// A snapshot of what the patient should be showing. Mirrored to localStorage so
// the pop-out reads the current state the instant it loads (no handshake race).
const patientState: { testId: string; go: boolean; last: PatientMessage | null } = {
  testId: PROTOCOL_TESTS[0].id,
  go: false,
  last: null,
};

/**
 * `createdAt` is a Date on a fresh take and can be a string once it has been
 * through storage, so every comparison and format goes through here. Passing a
 * string to Math.max() yields NaN, which surfaces as "Invalid Date" in the
 * chart rather than as an error.
 */
function timeOf(recording: Recording): number {
  return recording.createdAt instanceof Date
    ? recording.createdAt.getTime()
    : new Date(recording.createdAt).getTime();
}

function broadcastPatient(msg: PatientMessage): void {
  if (msg.kind === "test") patientState.testId = msg.testId;
  if (msg.kind === "go") patientState.go = msg.on;
  patientState.last = msg;

  if (clinicalChannel) clinicalChannel.postMessage(msg);
  if (patientWindowRef && !patientWindowRef.closed) {
    try { patientWindowRef.postMessage(msg, "*"); } catch { /* ignore */ }
  }
  try {
    localStorage.setItem("audiomx-patient", JSON.stringify({ ...patientState, seq: Date.now() }));
  } catch { /* ignore */ }
}

// ---- Direct control of the pop-out window (most reliable path) ----------
// Because the pop-out is same-origin and we hold its window handle, the
// clinician page can write straight into its DOM — no messaging needed.

function patientDoc(): Document | null {
  try {
    if (patientWindowRef && !patientWindowRef.closed &&
        patientWindowRef.document &&
        patientWindowRef.document.getElementById("pTaskTitle")) {
      return patientWindowRef.document;
    }
  } catch { /* cross-origin or not ready */ }
  return null;
}

function pushPromptToPopup(): void {
  const doc = patientDoc();
  if (!doc) return;
  const t = clinicalCurrentTest;

  const icon = doc.getElementById("pTaskIcon");
  if (icon) icon.textContent = t.icon;
  const title = doc.getElementById("pTaskTitle");
  if (title) title.textContent = t.patientTitle;

  const steps = doc.getElementById("pSteps");
  if (steps) {
    steps.innerHTML = "";
    t.patientSteps.forEach(s => { const li = doc.createElement("li"); li.textContent = s; steps.appendChild(li); });
  }

  const reads = doc.getElementById("pReads");
  if (!reads) return;
  reads.innerHTML = "";
  if (t.reads) {
    t.reads.forEach(l => {
      const p = doc.createElement("p");
      p.className = "patientReadLine";
      p.textContent = l;
      reads.appendChild(p);
    });
    reads.style.display = "block";
  } else {
    reads.style.display = "none";
  }
}

function pushGoToPopup(on: boolean): void {
  const doc = patientDoc();
  if (!doc) return;
  const go = doc.getElementById("pGoBar");
  if (!go) return;
  go.classList.toggle("go", on);
  go.textContent = on ? "● Recording — begin speaking" : "Get ready…";
}

function pushTimerToPopup(widthPct: number, visible: boolean): void {
  const doc = patientDoc();
  if (!doc) return;
  const wrap = doc.getElementById("pTimerWrap");
  if (wrap) wrap.style.display = visible ? "block" : "none";
  const bar = doc.getElementById("pTimerBar");
  if (bar) bar.style.width = widthPct + "%";
}

// Big countdown number on both patient screens.
function setCountNumber(text: string): void {
  const here = document.getElementById("pCountNumber");
  if (here) here.textContent = text;
  const doc = patientDoc();
  if (doc) {
    const there = doc.getElementById("pCountNumber");
    if (there) there.textContent = text;
  }
}

// The countdown beeps play through the application's single shared context —
// the same one the microphone is captured on. They used to have their own, and
// on macOS that second context made CoreAudio reconfigure the device mid-exam:
// the take came out the right length and completely silent. See
// core/audioContext.ts.

function clinicalBeep(freq: number, ms: number): void {
  try {
    const ctx = audioContext();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq || 880;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (ms || 150) / 1000);
    o.start();
    o.stop(ctx.currentTime + (ms || 150) / 1000);
    // Only the nodes are disposable; the context stays open for the next beep.
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* ignore */ } };
  } catch { /* ignore */ }
}

// Read the current task aloud (browser TTS) if the toggle is on.
function speakCurrentPrompt(): void {
  const speak = el<HTMLInputElement>("cSpeak");
  if (!speak || !speak.checked || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const t = clinicalCurrentTest;
    const u = new SpeechSynthesisUtterance(t.patientTitle + ". " + t.patientSteps.join(". "));
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

// ---- Patient "I'm ready" gate ------------------------------------------
// After the instructions are read, the patient (or clinician) presses a
// button to confirm they're ready. Only then does the countdown + recording
// start. The button lives on both the clinician's embedded patient panel and
// the pop-out; we wire its onclick straight to onPatientReady (the reliable
// direct-DOM path — no cross-window messaging needed).

function showReadyGate(on: boolean): void {
  // Clinician's embedded patient panel (same document).
  const embWrap = document.getElementById("pReadyWrap");
  if (embWrap) embWrap.style.display = on ? "block" : "none";
  const embBtn = document.getElementById("pReadyBtn");
  if (embBtn) embBtn.onclick = on ? onPatientReady : null;

  // Pop-out window (write straight into its DOM).
  const doc = patientDoc();
  if (doc) {
    const w = doc.getElementById("pReadyWrap");
    if (w) w.style.display = on ? "block" : "none";
    const b = doc.getElementById("pReadyBtn");
    if (b) b.onclick = on ? onPatientReady : null;
  }

  // Prompt bar copy while waiting for the patient.
  const barText = on ? "Listen to the instructions, then press “I'm ready”" : "Get ready…";
  if (pGoBar && on) { pGoBar.classList.remove("go"); pGoBar.textContent = barText; }
  const pdoc = patientDoc();
  if (pdoc && on) {
    const g = pdoc.getElementById("pGoBar");
    if (g) { g.classList.remove("go"); g.textContent = barText; }
  }
}

function onPatientReady(): void {
  if (clinicalPhase !== "waiting") return;
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  showReadyGate(false);
  beginCountdownAndRecord();
}

// Countdown, then start recording. Auto-stops at the test's hold duration
// (or runs until the clinician ends it, for open-ended tasks).
function beginCountdownAndRecord(): void {
  broadcastPatient({ kind: "countdown", seconds: READY_SECONDS });
  clinicalPhase = "ready";
  runGetReady(READY_SECONDS, async () => {
    if (clinicalPhase !== "ready") return; // cancelled during countdown
    clinicalPhase = "recording";
    setPatientRecording(true);
    await startRecording(activeTestMeta);
    startClinicalTimer(clinicalCurrentTest.holdSeconds);
  });
}

// After a good take, advance to the next protocol test automatically.
function advanceProtocol(): void {
  const idx = PROTOCOL_TESTS.findIndex(t => t.id === clinicalCurrentTest.id);
  if (idx >= 0 && idx < PROTOCOL_TESTS.length - 1) {
    selectClinicalTest(PROTOCOL_TESTS[idx + 1].id);
  }
}

const CONNECT_LABELS: Record<ConnectKind, string> = {
  usb: "Connect MEMS (USB)",
  wifi: "Connect MEMS (Wi-Fi)",
  computer: "Connect computer mic"
};
const CONNECT_IDS: Record<ConnectKind, string> = {
  usb: "cConnectUsb",
  wifi: "cConnectWifi",
  computer: "cConnectComputer",
};

// DOM refs, resolved once in initClinical(). Non-null because every id below
// is static markup in index.html — absence would be a bug, not a variant, and
// requireEl() names the missing element instead of failing later on null.
let cTestList: HTMLElement, cStartBtn: HTMLButtonElement, cStopBtn: HTMLButtonElement;
let cGateBox: HTMLElement, cTestName: HTMLElement, cTestNote: HTMLElement, cNotesInput: HTMLTextAreaElement;
let cWaveCanvas: HTMLCanvasElement, cWaveCtx: CanvasRenderingContext2D | null;
let cSpecCanvas: HTMLCanvasElement, cSpecCtx: CanvasRenderingContext2D | null;
let cRmsEl: HTMLElement, cPeakEl: HTMLElement, cClipEl: HTMLElement, cLevelBar: HTMLElement;
let pTaskTitle: HTMLElement, pTaskIcon: HTMLElement, pSteps: HTMLElement, pReads: HTMLElement;
let pGoBar: HTMLElement, pTimerBar: HTMLElement, pTimerWrap: HTMLElement;
let cPatientTable: HTMLElement, cPatientSearch: HTMLInputElement, cExamPatient: HTMLElement;
let cSessionLabel: HTMLElement, cChartPatient: HTMLElement, cChartFolders: HTMLElement;

export function initClinical(): void {
  cTestList = requireEl("cTestList");
  cStartBtn = requireEl<HTMLButtonElement>("cStartBtn");
  cStopBtn = requireEl<HTMLButtonElement>("cStopBtn");
  cGateBox = requireEl("cGateBox");
  cTestName = requireEl("cTestName");
  cTestNote = requireEl("cTestNote");
  cNotesInput = requireEl<HTMLTextAreaElement>("cNotes");

  cWaveCanvas = requireEl<HTMLCanvasElement>("cWaveform");
  cWaveCtx = cWaveCanvas.getContext("2d");
  cSpecCanvas = requireEl<HTMLCanvasElement>("cSpectrum");
  cSpecCtx = cSpecCanvas.getContext("2d");

  cRmsEl = requireEl("cRms");
  cPeakEl = requireEl("cPeak");
  cClipEl = requireEl("cClip");
  cLevelBar = requireEl("cLevelBar");

  pTaskTitle = requireEl("pTaskTitle");
  pTaskIcon = requireEl("pTaskIcon");
  pSteps = requireEl("pSteps");
  pReads = requireEl("pReads");
  pGoBar = requireEl("pGoBar");
  pTimerBar = requireEl("pTimerBar");
  pTimerWrap = requireEl("pTimerWrap");

  cPatientTable = requireEl("cPatientTable");
  cPatientSearch = requireEl<HTMLInputElement>("cPatientSearch");
  cExamPatient = requireEl("cExamPatient");
  cSessionLabel = requireEl("cSessionLabel");
  cChartPatient = requireEl("cChartPatient");
  cChartFolders = requireEl("cChartFolders");

  // Sub-tabs
  document.querySelectorAll<HTMLElement>(".clinTabBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset["ctab"];
      if (tab) setClinicalTab(tab);
    });
  });

  renderClinicalTestList();
  selectClinicalTest(PROTOCOL_TESTS[0].id);

  cStartBtn.addEventListener("click", () => void startClinicalTest());
  cStopBtn.addEventListener("click", () => void stopClinicalTest());
  cNotesInput.addEventListener("input", () => { clinicalNotes = cNotesInput.value; });

  requireEl("cNewPatientForm").addEventListener("submit", submitNewPatient);
  requireEl("cNpClear").addEventListener("click", resetNewPatientForm);
  requireEl("cNewSessionBtn").addEventListener("click", startNewSession);
  cPatientSearch.addEventListener("input", () => renderPatientTable());

  requireEl("cConnectUsb").addEventListener("click", () => void clinicalConnect("usb"));
  requireEl("cConnectWifi").addEventListener("click", () => void clinicalConnect("wifi"));
  requireEl("cConnectComputer").addEventListener("click", () => void clinicalConnect("computer"));
  requireEl("cPopoutBtn").addEventListener("click", openPatientView);
  requireEl("cExportPatientBtn").addEventListener("click", () => void downloadPatientAll());
  el("cExportFhirBtn")?.addEventListener("click", () => void downloadPatientFhir(currentPatient));

  // Space toggles Start/End while in the Exam tab (not while typing).
  window.addEventListener("keydown", event => {
    if (event.code !== "Space") return;
    if (ui.mode !== "clinical") return;
    if (requireEl("clinExam").hidden) return;
    const tag = ((event.target as HTMLElement | null)?.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    event.preventDefault();
    if (clinicalPhase === "idle") void startClinicalTest();
    else if (clinicalPhase === "waiting") onPatientReady();
    else void stopClinicalTest();
  });

  const handleReady = (data: PatientMessage | null | undefined): void => {
    if (data && data.kind === "ready") {
      broadcastPatient({ kind: "test", testId: clinicalCurrentTest.id });
      broadcastPatient({ kind: "go", on: capture.recording });
    }
  };
  if (clinicalChannel) clinicalChannel.onmessage = event => handleReady(event.data as PatientMessage);
  window.addEventListener("message", event => handleReady(event.data as PatientMessage));

  clearClinicalMonitors();
  updateClinicalConnectState();
  void loadClinicalPatients();
  setClinicalTab("patients");
}

export function setClinicalTab(name: string): void {
  requireEl("clinPatients").hidden = name !== "patients";
  requireEl("clinExam").hidden = name !== "exam";
  requireEl("clinChart").hidden = name !== "chart";
  if (name === "chart") renderChart();
  if (name === "exam") renderExamHeader();
  // Opening a patient row calls this directly; the bar follows.
  reflectNav();
}

// ---- Connection --------------------------------------------------------

async function clinicalConnect(kind: ConnectKind): Promise<void> {
  clinicalConnectKind = kind;
  if (kind === "computer") {
    await setInputSource("computer");
    await connectComputerMic();
  } else {
    await setInputSource("mems");
    if (kind === "wifi") connectWifiMems();
    else await connectSerial();
  }
  // Wi-Fi connects asynchronously; check shortly after.
  updateClinicalConnectState();
  setTimeout(updateClinicalConnectState, 800);
}

function updateClinicalConnectState(): void {
  for (const k of Object.keys(CONNECT_IDS) as ConnectKind[]) {
    const b = el(CONNECT_IDS[k]);
    if (!b) continue;
    b.classList.remove("primaryBtn");
    b.classList.add("secondaryBtn");
    b.textContent = CONNECT_LABELS[k];
  }
  if (device.connected && clinicalConnectKind) {
    const b = el(CONNECT_IDS[clinicalConnectKind]);
    if (b) {
      b.classList.remove("secondaryBtn");
      b.classList.add("primaryBtn");
      b.textContent = "✓ Connected — " + CONNECT_LABELS[clinicalConnectKind].replace("Connect ", "");
    }
  }
}

// ---- Patient database --------------------------------------------------

export async function loadClinicalPatients(): Promise<void> {
  clinicalPatients = await loadPatients();
  const known = new Set(clinicalPatients.map(p => p.id));
  for (const r of library.recordings) {
    if (r.meta && r.meta.patientId && !known.has(r.meta.patientId)) {
      known.add(r.meta.patientId);
      // Recovered from a take whose patient record is gone: id and name are
      // all the take carries, so age and sex stay blank.
      clinicalPatients.push({
        id: r.meta.patientId,
        name: r.meta.patientName || "",
        age: "",
        sex: "",
        createdAt: r.createdAt,
      });
    }
  }
  renderPatientTable();
  renderExamHeader();
  renderChart();
}

function patientRecordingCount(id: string): number {
  return library.recordings.filter(r => r.meta && r.meta.patientId === id).length;
}

function patientLastDate(id: string): Date | null {
  const takes = library.recordings.filter(r => r.meta && r.meta.patientId === id);
  if (!takes.length) return null;
  return new Date(Math.max(...takes.map(timeOf)));
}

function demographicsStr(p: StoredPatient | null): string {
  if (!p) return "";
  return [p.age ? p.age + " y" : "", p.sex || ""].filter(Boolean).join(", ");
}

export function renderPatientTable(): void {
  if (!cPatientTable) return;
  const q = (cPatientSearch.value || "").trim().toLowerCase();

  const list = clinicalPatients
    .filter(p => !q || p.id.toLowerCase().includes(q) || (p.name || "").toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (list.length === 0) {
    cPatientTable.innerHTML = "<div class='empty'>" +
      (clinicalPatients.length ? "No patients match." : "No patients yet. Click “New patient”.") + "</div>";
    return;
  }

  cPatientTable.innerHTML = "";
  for (const p of list) {
    const last = patientLastDate(p.id);
    const row = document.createElement("div");
    row.className = "patientRow" + (currentPatient && currentPatient.id === p.id ? " active" : "");
    row.innerHTML =
      "<div class='patientRowMain'><strong>" + p.id + "</strong>" +
      (p.name ? " <span class='patientRowName'>" + p.name + "</span>" : "") + "</div>" +
      "<div class='patientRowMeta'>" + patientRecordingCount(p.id) + " rec · " +
      (last ? last.toLocaleDateString() : "—") + "</div>";

    const open = document.createElement("button");
    open.className = "smallBtn analyzeBtn";
    open.textContent = "Open";
    open.onclick = () => openPatient(p.id);

    const del = document.createElement("button");
    del.className = "smallBtn deleteBtn";
    del.textContent = "Delete";
    del.onclick = () => deletePatient(p.id);

    const actions = document.createElement("div");
    actions.className = "patientRowActions";
    actions.appendChild(open);
    actions.appendChild(del);
    row.appendChild(actions);
    cPatientTable.appendChild(row);
  }
}

// The form sits permanently above the patient list, so "reset" is all the
// Clear button and a successful create both need.
function resetNewPatientForm(): void {
  const form = el<HTMLFormElement>("cNewPatientForm");
  if (!form) return;
  form.reset();
  const err = el("cNpError");
  if (err) err.hidden = true;
}

function submitNewPatient(event: Event): void {
  event.preventDefault();

  const err = requireEl("cNpError");
  const idInput = requireEl<HTMLInputElement>("cNpId");
  const id = idInput.value.trim();
  if (!id) {
    err.textContent = "Patient ID is required.";
    err.hidden = false;
    idInput.focus();
    return;
  }

  // Reusing an existing ID opens that patient rather than silently creating a
  // duplicate — same behaviour the prompt() flow had.
  let patient = clinicalPatients.find(p => p.id === id);
  if (!patient) {
    patient = {
      id,
      name: requireEl<HTMLInputElement>("cNpName").value.trim(),
      age: requireEl<HTMLInputElement>("cNpAge").value.trim(),
      sex: requireEl<HTMLSelectElement>("cNpSex").value,
      createdAt: new Date()
    };
    clinicalPatients.push(patient);
    void savePatient(patient);
    log("Patient created: " + id);
  } else {
    log("Patient " + id + " already exists — opening it.");
  }

  resetNewPatientForm();
  renderPatientTable();
  openPatient(id);
}

function openPatient(id: string): void {
  currentPatient = clinicalPatients.find(p => p.id === id) || null;
  currentSessionId = null;
  renderPatientTable();
  renderExamHeader();
  renderChart();
  setClinicalTab("exam");
}

function deletePatient(id: string): void {
  const count = patientRecordingCount(id);
  if (!confirm("Delete patient " + id + " and their " + count + " recording(s)?")) return;
  library.recordings
    .filter(r => r.meta && r.meta.patientId === id)
    .forEach(r => deleteRecording(r.id));
  clinicalPatients = clinicalPatients.filter(p => p.id !== id);
  void deletePatientFromDb(id);
  if (currentPatient && currentPatient.id === id) {
    currentPatient = null;
    currentSessionId = null;
  }
  renderPatientTable();
  renderExamHeader();
  renderChart();
}

export function startNewSession(): void {
  if (!currentPatient) {
    alert("Select a patient first (Patients tab).");
    setClinicalTab("patients");
    return;
  }
  currentSessionId = "S-" + Date.now();
  renderExamHeader();
  log("New session started for " + currentPatient.id + ".");
}

function sessionNumberOf(sessionId: string): number | string {
  if (!currentPatient) return "?";
  const sessions = patientSessions(currentPatient.id);
  const found = sessions.find(s => s.id === sessionId);
  return found ? found.number : sessions.length + 1;
}

export function renderExamHeader(): void {
  if (!cExamPatient) return;
  if (!currentPatient) {
    cExamPatient.innerHTML = "<em>No patient selected.</em> Pick one in the Patients tab.";
    cSessionLabel.textContent = "—";
    return;
  }
  cExamPatient.innerHTML = "<strong>" + currentPatient.id + "</strong>" +
    (currentPatient.name ? " — " + currentPatient.name : "") +
    (demographicsStr(currentPatient) ? " · " + demographicsStr(currentPatient) : "") +
    " · " + patientRecordingCount(currentPatient.id) + " recording(s)";
  cSessionLabel.textContent = currentSessionId
    ? "Session " + sessionNumberOf(currentSessionId) + " (active)"
    : "No active session — starts on first take";
}

// ---- Test selection + patient prompt -----------------------------------

function renderClinicalTestList(): void {
  cTestList.innerHTML = "";
  for (const test of PROTOCOL_TESTS) {
    const btn = document.createElement("button");
    btn.className = "clinTestBtn";
    btn.dataset["test"] = test.id;
    btn.innerHTML = "<span class='clinTestIcon'>" + test.icon + "</span><span>" + test.name + "</span>";
    btn.addEventListener("click", () => selectClinicalTest(test.id));
    cTestList.appendChild(btn);
  }
}

export function selectClinicalTest(id: string): void {
  if (capture.recording) return;
  clinicalCurrentTest = getProtocolTest(id) || PROTOCOL_TESTS[0];
  document.querySelectorAll<HTMLElement>(".clinTestBtn")
    .forEach(b => b.classList.toggle("active", b.dataset["test"] === clinicalCurrentTest.id));
  cTestName.textContent = clinicalCurrentTest.name;
  cTestNote.textContent = clinicalCurrentTest.clinicianNote;
  renderPatientPrompt(clinicalCurrentTest);
  pushPromptToPopup();
  broadcastPatient({ kind: "test", testId: clinicalCurrentTest.id });
}

function renderPatientPrompt(test: ProtocolTest): void {
  pTaskIcon.textContent = test.icon;
  pTaskTitle.textContent = test.patientTitle;
  pSteps.innerHTML = "";
  for (const step of test.patientSteps) {
    const li = document.createElement("li");
    li.textContent = step;
    pSteps.appendChild(li);
  }
  pReads.innerHTML = "";
  if (test.reads) {
    for (const line of test.reads) {
      const p = document.createElement("p");
      p.className = "patientReadLine";
      p.textContent = line;
      pReads.appendChild(p);
    }
    pReads.style.display = "block";
  } else {
    pReads.style.display = "none";
  }
}

// ---- Run a test --------------------------------------------------------

async function startClinicalTest(): Promise<void> {
  if (!currentPatient) {
    alert("Select a patient first (Patients tab).");
    setClinicalTab("patients");
    return;
  }
  if (!device.connected) {
    setStatus("Connect a microphone first", "idle");
    log("Clinical: connect a microphone before starting a test.");
    return;
  }
  const consent = el<HTMLInputElement>("cConsent");
  if (consent && !consent.checked) {
    alert("Please confirm informed consent (checkbox) before recording.");
    return;
  }
  if (!currentSessionId) currentSessionId = "S-" + Date.now();
  hideClinicalGate();

  // Optionally read the task aloud for the patient.
  speakCurrentPrompt();

  activeTestMeta = {
    patientId: currentPatient.id,
    patientName: currentPatient.name || "",
    sessionId: currentSessionId,
    testId: clinicalCurrentTest.id,
    testName: clinicalCurrentTest.name,
    notes: clinicalNotes
  };

  cStartBtn.disabled = true;
  cStopBtn.disabled = false; // allow cancel while waiting / counting down
  renderExamHeader();

  // Step 1: read the instructions to the patient and show the "I'm ready"
  // button. The countdown + recording only begin once the patient (or the
  // clinician on their behalf) presses it — see onPatientReady().
  clinicalPhase = "waiting";
  showReadyGate(true);
}

async function stopClinicalTest(): Promise<void> {
  // Cancel if we haven't started recording yet (waiting on the patient's
  // "I'm ready", or mid get-ready countdown).
  if (clinicalPhase === "waiting" || clinicalPhase === "ready") {
    clinicalPhase = "idle";
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    showReadyGate(false);
    stopClinicalTimer();
    setPatientRecording(false);
    cStartBtn.disabled = false;
    cStopBtn.disabled = true;
    activeTestMeta = null;
    return;
  }

  clinicalPhase = "idle";
  await stopRecording();
  setPatientRecording(false);
  stopClinicalTimer();
  cStartBtn.disabled = false;
  cStopBtn.disabled = true;
  activeTestMeta = null;
  runClinicalQualityGate();
}

export function onClinicalRecordingSaved(recording: Recording): void {
  lastClinicalRecording = recording;
  renderExamHeader();
  renderChart();
  renderPatientTable();
}

function setPatientRecording(on: boolean): void {
  broadcastPatient({ kind: "go", on: on });
  pushGoToPopup(on);
  if (!pGoBar) return;
  pGoBar.classList.toggle("go", on);
  pGoBar.textContent = on ? "● Recording — begin speaking" : "Get ready…";
}

// Set both timer bars (in-app + pop-out) at once.
function setTimerBars(widthPct: number, visible: boolean): void {
  if (pTimerWrap) pTimerWrap.style.display = visible ? "block" : "none";
  if (pTimerBar) pTimerBar.style.width = widthPct + "%";
  pushTimerToPopup(widthPct, visible);
}

// 5-second "get ready" countdown, driven by the clinician (updates both bars).
function runGetReady(seconds: number, onDone: () => void): void {
  stopClinicalTimer();
  if (pGoBar) { pGoBar.classList.remove("go"); pGoBar.textContent = "Get ready…"; }
  pushGoToPopup(false);
  const start = performance.now();
  const dur = seconds * 1000;
  setTimerBars(100, true);
  let lastSec = -1;
  clinicalTimer = window.setInterval(() => {
    const elapsed = performance.now() - start;
    const remain = Math.max(0, 1 - elapsed / dur);
    setTimerBars(remain * 100, true);

    const secLeft = Math.ceil((dur - elapsed) / 1000);
    if (secLeft !== lastSec && secLeft > 0) {
      lastSec = secLeft;
      setCountNumber(String(secLeft));
      clinicalBeep(660, 90);
    }

    if (remain <= 0) {
      stopClinicalTimer();
      setCountNumber("");
      clinicalBeep(GO_BEEP_HZ, GO_BEEP_MS);
      // After the tone, not with it.
      setTimeout(onDone, GO_BEEP_MS);
    }
  }, 60);
}

function startClinicalTimer(seconds: number | null): void {
  stopClinicalTimer();
  clinicalTimerStart = performance.now();
  clinicalTimerDuration = seconds ? seconds * 1000 : 0;
  broadcastPatient({ kind: "timerStart", seconds: seconds });
  setTimerBars(100, true);
  clinicalTimer = window.setInterval(() => {
    const elapsed = performance.now() - clinicalTimerStart;
    const w = clinicalTimerDuration > 0
      ? Math.max(0, 1 - elapsed / clinicalTimerDuration) * 100
      : Math.min(100, (elapsed / 60000) * 100);
    setTimerBars(w, true);

    // Auto-stop when a fixed-duration task reaches its target.
    if (clinicalTimerDuration > 0 && elapsed >= clinicalTimerDuration && clinicalPhase === "recording") {
      void stopClinicalTest();
    }
  }, 100);
}

function stopClinicalTimer(): void {
  if (clinicalTimer) { clearInterval(clinicalTimer); clinicalTimer = null; }
  broadcastPatient({ kind: "timerStop" });
  setTimerBars(100, true);
}

// ---- Quality gate ------------------------------------------------------

function runClinicalQualityGate(): void {
  if (!lastClinicalRecording || !lastClinicalRecording.analysisSamples) return;
  const m = clinicalMetricsOf(lastClinicalRecording.analysisSamples);
  const problems: string[] = [];
  if (m.clip > 0.5) problems.push("Clipping (" + m.clip.toFixed(1) + "%) — lower gain (raise PCM_SHIFT).");
  if (m.peak > -1) problems.push("Level too hot (peak " + m.peak.toFixed(1) + " dBFS).");
  if (m.rms < -55) problems.push("Very quiet (RMS " + m.rms.toFixed(1) + " dBFS) — move closer or check the mic.");
  if (problems.length === 0) {
    showClinicalGate(true, "Good take — RMS " + m.rms.toFixed(1) + " dBFS, peak " + m.peak.toFixed(1) + " dBFS.", []);
  } else {
    showClinicalGate(false, "Check this recording:", problems);
  }
}

function showClinicalGate(ok: boolean, headline: string, problems: string[]): void {
  cGateBox.style.display = "block";
  cGateBox.className = "clinGate " + (ok ? "gateOk" : "gateWarn");
  let html = "<div class='gateHead'>" + headline + "</div>";
  if (problems.length) html += "<ul>" + problems.map(p => "<li>" + p + "</li>").join("") + "</ul>";
  html += "<div class='gateBtns'><button id='gateContinue' class='smallBtn'>Continue</button>" +
    "<button id='gateRedo' class='smallBtn deleteBtn'>Record again</button></div>";
  cGateBox.innerHTML = html;

  // Queried through cGateBox, not by id: these two buttons are created by the
  // innerHTML above and replaced every time the gate is shown, so the cached
  // lookups in ui/dom would hand back a detached node from the previous take.
  cGateBox.querySelector("#gateContinue")?.addEventListener("click", () => {
    hideClinicalGate();
    if (ok) advanceProtocol(); // good take → move to the next test
  });
  cGateBox.querySelector("#gateRedo")?.addEventListener("click", () => {
    if (lastClinicalRecording) { deleteClinicalRecording(lastClinicalRecording.id, true); lastClinicalRecording = null; }
    hideClinicalGate();
  });
}

function hideClinicalGate(): void {
  if (cGateBox) { cGateBox.style.display = "none"; cGateBox.innerHTML = ""; }
}

// ---- Patient chart: sessions as folders --------------------------------

export function patientSessions(patientId: string): PatientSession[] {
  const takes = library.recordings.filter(r => r.meta && r.meta.patientId === patientId);

  const map = new Map<string, Recording[]>();
  for (const t of takes) {
    const sessionId = t.meta?.sessionId ?? "";
    const bucket = map.get(sessionId);
    if (bucket) bucket.push(t);
    else map.set(sessionId, [t]);
  }

  const startOf = (id: string): number => Math.min(...(map.get(id) ?? []).map(timeOf));
  const ids = [...map.keys()].sort((a, b) => startOf(a) - startOf(b));

  return ids.map((id, i) => ({
    id,
    number: i + 1,
    takes: (map.get(id) ?? []).sort((a, b) => timeOf(a) - timeOf(b)),
    date: new Date(startOf(id))
  }));
}

// ---- Per-patient trend view (features across sessions) -----------------
// For each acoustic measure, average the voiced takes within a session and
// plot one point per session so a clinician can see change over time.

/** Numeric fields of a voiced VoiceFeatures — what a trend can be drawn from. */
type TrendKey = "f0" | "hnrDb" | "jitterPct" | "shimmerPct";

interface TrendMetric {
  key: TrendKey;
  label: string;
  unit: string;
  digits: number;
  /** true when higher is healthier, false when lower is, null when neither. */
  betterUp: boolean | null;
}

const TREND_METRICS: TrendMetric[] = [
  { key: "f0", label: "F0 (pitch)", unit: "Hz", digits: 0, betterUp: null },
  { key: "hnrDb", label: "HNR", unit: "dB", digits: 1, betterUp: true },
  { key: "jitterPct", label: "Jitter", unit: "%", digits: 2, betterUp: false },
  { key: "shimmerPct", label: "Shimmer", unit: "%", digits: 1, betterUp: false }
];

/** One session's value for one metric, as plotted. */
interface TrendPoint {
  n: number;
  v: number;
}

function sessionFeatureMean(session: PatientSession, key: TrendKey): number | null {
  const vals: number[] = [];
  for (const t of session.takes) {
    const f: VoiceFeatures | null = t.features;
    if (f && f.voiced && isFinite(f[key])) vals.push(f[key]);
  }
  if (!vals.length) return null;
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}

// Tiny inline SVG line chart from a list of {n, v} points.
function trendSparkline(points: TrendPoint[], betterUp: boolean | null): string {
  const W = 240, H = 64, padX = 6, padY = 10;
  if (points.length === 0) return "<svg width='" + W + "' height='" + H + "'></svg>";

  const vs = points.map(p => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;

  const x = (i: number): number => points.length === 1
    ? W / 2
    : padX + (i / (points.length - 1)) * (W - 2 * padX);
  const y = (v: number): number => H - padY - ((v - min) / span) * (H - 2 * padY);

  let path = "";
  points.forEach((p, i) => { path += (i === 0 ? "M" : "L") + x(i).toFixed(1) + " " + y(p.v).toFixed(1) + " "; });

  let dots = "";
  points.forEach((p, i) => {
    dots += "<circle cx='" + x(i).toFixed(1) + "' cy='" + y(p.v).toFixed(1) +
      "' r='3' fill='" + PLOT.trace + "'></circle>";
  });

  // Colour the trend direction (last vs first) when a direction is "better".
  let stroke: string = PLOT.trace;
  if (betterUp !== null && points.length >= 2) {
    const rising = points[points.length - 1].v > points[0].v;
    const good = betterUp ? rising : !rising;
    stroke = good ? "#2e9e5b" : "#c0492f";
  }

  return "<svg width='" + W + "' height='" + H + "' class='trendSvg'>" +
    "<path d='" + path.trim() + "' fill='none' stroke='" + stroke + "' stroke-width='2'></path>" +
    dots + "</svg>";
}

function renderPatientTrends(): void {
  const box = el("cChartTrends");
  if (!box) return;
  if (!currentPatient) { box.innerHTML = ""; return; }

  const sessions = patientSessions(currentPatient.id).filter(s => s.takes.length);
  if (sessions.length < 1) {
    box.innerHTML = "";
    return;
  }

  let html = "<div class='trendHead'>Trends across sessions " +
    "<span class='featureTag'>preview</span></div><div class='trendGrid'>";

  for (const metric of TREND_METRICS) {
    const points: TrendPoint[] = [];
    sessions.forEach(s => {
      const v = sessionFeatureMean(s, metric.key);
      if (v != null) points.push({ n: s.number, v: v });
    });

    let valueLine = "<span class='trendNoData'>no voiced data yet</span>";
    if (points.length) {
      const latest = points[points.length - 1].v;
      valueLine = "<strong>" + latest.toFixed(metric.digits) + "</strong> " + metric.unit;
      if (points.length >= 2) {
        const delta = latest - points[0].v;
        const sign = delta >= 0 ? "+" : "";
        valueLine += " <span class='trendDelta'>(" + sign + delta.toFixed(metric.digits) +
          " since S" + points[0].n + ")</span>";
      }
    }

    html += "<div class='trendCard'>" +
      "<div class='trendLabel'>" + metric.label + "</div>" +
      "<div class='trendValue'>" + valueLine + "</div>" +
      trendSparkline(points, metric.betterUp) +
      "</div>";
  }

  html += "</div><div class='trendFoot'>Each point is the mean of voiced takes in a session " +
    "(S1 → S" + sessions[sessions.length - 1].number + ").</div>";
  box.innerHTML = html;
}

export function renderChart(): void {
  if (!cChartFolders) return;
  if (!currentPatient) {
    if (cChartPatient) cChartPatient.textContent = "No patient selected.";
    cChartFolders.innerHTML = "<div class='empty'>Open a patient from the Patients tab.</div>";
    renderPatientTrends();
    return;
  }
  renderPatientTrends();
  if (cChartPatient) {
    cChartPatient.innerHTML = "<strong>" + currentPatient.id + "</strong>" +
      (currentPatient.name ? " — " + currentPatient.name : "");
  }

  const sessions = patientSessions(currentPatient.id).slice().reverse(); // newest first

  // Show the active-but-empty session as a folder too.
  if (currentSessionId && !sessions.find(s => s.id === currentSessionId)) {
    const number = sessionNumberOf(currentSessionId);
    sessions.unshift({
      id: currentSessionId,
      number: typeof number === "number" ? number : sessions.length + 1,
      takes: [],
      date: new Date(),
    });
  }

  if (sessions.length === 0) {
    cChartFolders.innerHTML = "<div class='empty'>No sessions yet. Go to the Exam tab and run a test.</div>";
    return;
  }

  cChartFolders.innerHTML = "";
  for (const s of sessions) {
    const folder = document.createElement("details");
    folder.className = "sessionFolder";
    folder.open = true;

    const summary = document.createElement("summary");
    summary.className = "sessionFolderHead";
    summary.innerHTML = "📁 <strong>Session " + s.number + "</strong> · " +
      s.date.toLocaleString() + " · " + s.takes.length + " take(s)";
    folder.appendChild(summary);

    if (s.takes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No takes yet in this session.";
      folder.appendChild(empty);
    } else {
      const exportBtn = document.createElement("button");
      exportBtn.className = "smallBtn";
      exportBtn.textContent = "Download session (ZIP)";
      exportBtn.onclick = () => void downloadClinicalSession(s.id);
      folder.appendChild(exportBtn);

      for (const r of s.takes) {
        folder.appendChild(renderChartTake(r));
      }
    }
    cChartFolders.appendChild(folder);
  }
}

function renderChartTake(r: Recording): HTMLElement {
  const row = document.createElement("div");
  row.className = "chartRow";
  const title = document.createElement("div");
  title.className = "chartRowTitle";
  title.textContent = (r.name || r.meta?.testName || "take") + " · " + r.duration.toFixed(2) + " s" +
    (r.filtered ? " · 🧹 filtered" : "");
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = r.url;

  const analysis = document.createElement("div");
  analysis.className = "featureCard";
  analysis.innerHTML =
    "<div class='featureHead'>Acoustic features <span class='featureTag'>preview</span></div>" +
    "<div class='featureBody'>" + (r.features ? formatFeatures(r.features) : "—") + "</div>" +
    "<div class='aiScore'>AI risk score: <strong>pending model</strong> — features above feed the model.</div>";

  const btns = document.createElement("div");
  btns.className = "cardButtons";
  const analyzeBtn = document.createElement("button");
  analyzeBtn.className = "smallBtn analyzeBtn";
  analyzeBtn.textContent = "Analyze";
  analyzeBtn.onclick = () => { setAppMode("rnd"); analyzeRecording(r.id); };
  const renameBtn = document.createElement("button");
  renameBtn.className = "smallBtn";
  renameBtn.textContent = "Rename";
  renameBtn.onclick = () => renameRecording(r.id);
  const dl = document.createElement("button");
  dl.className = "smallBtn downloadBtn";
  dl.textContent = "WAV";
  dl.onclick = () => downloadRecording(r);
  const del = document.createElement("button");
  del.className = "smallBtn deleteBtn";
  del.textContent = "Delete";
  del.onclick = () => deleteClinicalRecording(r.id);

  btns.appendChild(analyzeBtn);
  btns.appendChild(renameBtn);
  btns.appendChild(dl);
  btns.appendChild(del);
  row.appendChild(title);
  row.appendChild(audio);
  row.appendChild(analysis);
  row.appendChild(btns);
  return row;
}

/**
 * Remove one take from the patient's chart. Exported so the smoke suite can
 * drive it; every in-app caller is below.
 */
export function deleteClinicalRecording(id: number, skipConfirm = false): void {
  const r = library.recordings.find(x => x.id === id);
  if (!r) return;
  if (!skipConfirm && !confirm("Delete this recording?")) return;
  deleteRecording(id);
  renderExamHeader();
  renderChart();
  renderPatientTable();
}

// ---- Session export (WAVs + manifest.csv as one ZIP) -------------------

function clinicalMetricsOf(samples: ArrayLike<number> | null): ClinicalMetrics {
  if (!samples || !samples.length) return { rms: -120, peak: -120, clip: 0 };
  let sumSq = 0, peak = 0, clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    sumSq += samples[i] * samples[i];
    if (a > peak) peak = a;
    if (a > 32000) clipped++;
  }
  return { rms: dbfs(Math.sqrt(sumSq / samples.length)), peak: dbfs(peak), clip: (clipped / samples.length) * 100 };
}

function csvCell(v: unknown): string {
  return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
}

const MANIFEST_HEADER = [
  "patient_id", "patient_name", "age", "sex", "session_id", "test_id", "test_name",
  "filename", "custom_name", "filtered", "duration_s",
  "f0_hz", "jitter_pct", "shimmer_pct", "hnr_db", "f1_hz", "f2_hz",
  "rms_dbfs", "peak_dbfs", "clipping_pct", "channels", "sample_rate_hz", "notes", "timestamp"
];

function num(v: number | null | undefined, d: number): string {
  return v == null || isNaN(v) ? "" : v.toFixed(d);
}

async function exportRecordingsZip(items: Recording[], zipName: string): Promise<void> {
  const files: ZipFile[] = [];
  const rows = [MANIFEST_HEADER.map(csvCell).join(",")];

  for (const r of items) {
    const fname = recordingBaseName(r) + ".wav";
    files.push({ name: fname, data: new Uint8Array(await r.blob.arrayBuffer()) });

    const m = clinicalMetricsOf(r.analysisSamples);
    // Only a voiced take carries measurements; an unvoiced one leaves the
    // acoustic columns blank rather than writing zeros that read as data.
    const f = r.features?.voiced ? r.features : null;
    const patient = clinicalPatients.find(p => r.meta && p.id === r.meta.patientId);

    rows.push([
      r.meta?.patientId ?? "", r.meta?.patientName || "", patient?.age || "", patient?.sex || "",
      r.meta?.sessionId ?? "", r.meta?.testId ?? "", r.meta?.testName ?? "", fname, r.name || "",
      r.filtered ? "yes" : "no", r.duration.toFixed(3),
      num(f?.f0, 1), num(f?.jitterPct, 3), num(f?.shimmerPct, 2), num(f?.hnrDb, 1),
      f?.f1 || "", f?.f2 || "",
      m.rms.toFixed(1), m.peak.toFixed(1), m.clip.toFixed(2), r.channels, SAMPLE_RATE,
      r.meta?.notes || "", new Date(timeOf(r)).toISOString()
    ].map(csvCell).join(","));
  }

  files.push({ name: "manifest.csv", data: new TextEncoder().encode(rows.join("\n")) });
  const zip = createZip(files);
  const url = URL.createObjectURL(zip);
  triggerDownload(url, zipName);
  URL.revokeObjectURL(url);
}

async function downloadClinicalSession(sessionId: string): Promise<void> {
  const items = library.recordings.filter(r => r.meta && r.meta.sessionId === sessionId);
  if (items.length === 0) { alert("No recordings in this session."); return; }
  await exportRecordingsZip(items, "AudioMX_" + sanitizeForFilename(sessionId) + ".zip");
  log("Session exported: " + items.length + " take(s) + manifest.csv.");
}

async function downloadPatientAll(): Promise<void> {
  if (!currentPatient) { alert("Open a patient first."); return; }
  const patient = currentPatient;
  const items = library.recordings.filter(r => r.meta && r.meta.patientId === patient.id);
  if (items.length === 0) { alert("No recordings for this patient."); return; }
  await exportRecordingsZip(items, "AudioMX_patient_" + sanitizeForFilename(patient.id) + ".zip");
  log("Patient export: " + items.length + " take(s) across all sessions.");
}

// ---- Pop-out patient window --------------------------------------------

function openPatientView(): void {
  // ?v= busts the browser cache so the window always loads the newest code.
  const url = "patient.html?v=" + Date.now();
  patientWindowRef = window.open(url, "audiomxPatient", "width=1024,height=768");

  // A pop-up blocker returns null, and so does iOS: a standalone home-screen
  // app has no second window to hand out. Saying nothing made this look exactly
  // like a dead button. The session is not lost either — the patient screen
  // also follows along over BroadcastChannel and localStorage, so a window the
  // clinician opens by hand on the patient's screen stays in sync.
  if (!patientWindowRef) {
    const manual = new URL(url, location.href).href;
    log("Patient window blocked by the browser. Open this address on the " +
      "patient's screen instead — it follows the session: " + manual);
    alert(
      "The browser blocked the patient window.\n\n" +
      "Allow pop-ups for this site, or open this address on the patient's " +
      "screen — it follows the session automatically:\n\n" + manual);
    return;
  }

  // Directly write the current prompt into the pop-out as soon as it is ready.
  // Poll for a couple of seconds since onload timing varies.
  let tries = 0;
  const push = (): void => {
    if (tries++ > 30) return;
    if (patientDoc()) {
      pushPromptToPopup();
      pushGoToPopup(clinicalPhase === "recording");
      showReadyGate(clinicalPhase === "waiting");
    }
    // Messaging fallbacks too (harmless if blocked).
    broadcastPatient({ kind: "test", testId: clinicalCurrentTest.id });
    setTimeout(push, 200);
  };
  push();
}

// ---- Clinician live monitors -------------------------------------------

export function clearClinicalMonitors(): void {
  if (cWaveCtx) {
    cWaveCtx.fillStyle = "#f0f0f2";
    cWaveCtx.fillRect(0, 0, cWaveCanvas.width, cWaveCanvas.height);
    cWaveCtx.strokeStyle = "#b8b8bd";
    cWaveCtx.beginPath();
    cWaveCtx.moveTo(0, cWaveCanvas.height / 2);
    cWaveCtx.lineTo(cWaveCanvas.width, cWaveCanvas.height / 2);
    cWaveCtx.stroke();
  }
  if (cSpecCtx) {
    cSpecCtx.fillStyle = "#f0f0f2";
    cSpecCtx.fillRect(0, 0, cSpecCanvas.width, cSpecCanvas.height);
  }
}

export function drawClinicalMonitors(): void {
  drawClinicalWaveform();
  drawClinicalSpectrum();
  updateClinicalMetrics(capture.live);
}

function drawClinicalWaveform(): void {
  if (!cWaveCtx) return;
  const live = capture.live;
  const w = cWaveCanvas.width, h = cWaveCanvas.height;
  cWaveCtx.fillStyle = "#f0f0f2";
  cWaveCtx.fillRect(0, 0, w, h);
  cWaveCtx.strokeStyle = "#dfe6f2";
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    cWaveCtx.beginPath();
    cWaveCtx.moveTo(0, y);
    cWaveCtx.lineTo(w, y);
    cWaveCtx.stroke();
  }
  if (live.length < 2) return;
  cWaveCtx.strokeStyle = PLOT.trace;
  cWaveCtx.lineWidth = 2;
  cWaveCtx.beginPath();
  const step = Math.max(1, Math.floor(live.length / w));
  let x = 0;
  for (let i = 0; i < live.length; i += step) {
    const y = h / 2 - (live[i] / 32768) * h * 0.42;
    if (x === 0) cWaveCtx.moveTo(x, y); else cWaveCtx.lineTo(x, y);
    x++;
    if (x >= w) break;
  }
  cWaveCtx.stroke();
}

function drawClinicalSpectrum(): void {
  if (!cSpecCtx) return;
  const live = capture.live;
  const w = cSpecCanvas.width, h = cSpecCanvas.height;
  cSpecCtx.fillStyle = "#f0f0f2";
  cSpecCtx.fillRect(0, 0, w, h);
  const n = Math.min(live.length, 4096);
  if (n < 512) return;
  const spectrum = computeSpectrum(Int16Array.from(live.slice(live.length - n)));
  if (!spectrum) return;
  const maxFreq = SAMPLE_RATE / 2, minDb = -100, maxDb = 0;
  cSpecCtx.fillStyle = "#9aa4b3";
  cSpecCtx.font = "11px -apple-system, BlinkMacSystemFont, Arial";
  for (let f = 2000; f < maxFreq; f += 2000) {
    const x = (f / maxFreq) * w;
    cSpecCtx.strokeStyle = "#e6ebf3";
    cSpecCtx.beginPath();
    cSpecCtx.moveTo(x, 0);
    cSpecCtx.lineTo(x, h);
    cSpecCtx.stroke();
    cSpecCtx.fillText(f / 1000 + " kHz", x + 3, h - 6);
  }
  for (const d of [0, -25, -50, -75]) {
    const y = h - ((d - minDb) / (maxDb - minDb)) * h;
    cSpecCtx.fillText(d + " dBFS", 6, d === 0 ? y + 12 : y - 3);
  }
  cSpecCtx.strokeStyle = PLOT.trace;
  cSpecCtx.lineWidth = 1.6;
  cSpecCtx.beginPath();
  let started = false;
  for (let i = 0; i < spectrum.magnitudes.length; i++) {
    const freq = spectrum.frequencies[i];
    if (freq > maxFreq) break;
    const x = (freq / maxFreq) * w;
    let y = h - ((spectrum.magnitudes[i] - minDb) / (maxDb - minDb)) * h;
    if (y < 0) y = 0;
    if (y > h) y = h;
    if (!started) { cSpecCtx.moveTo(x, y); started = true; } else cSpecCtx.lineTo(x, y);
  }
  cSpecCtx.stroke();
}

function updateClinicalMetrics(samples: ArrayLike<number> | null): void {
  if (!samples || samples.length === 0 || !cRmsEl) return;
  const m = clinicalMetricsOf(Int16Array.from(samples));
  cRmsEl.textContent = m.rms.toFixed(1) + " dBFS";
  cPeakEl.textContent = m.peak.toFixed(1) + " dBFS";
  cClipEl.textContent = m.clip.toFixed(2) + "%";
  cLevelBar.style.width = clamp(((m.rms + 80) / 80) * 100, 0, 100) + "%";
}

// ---- Subscriptions ------------------------------------------------------
//
// Registered on import, once. Everything that used to call into this file from
// a lower layer — the ingest path, storage, the R&D library — now announces
// what happened instead, which is what lets core/ and storage/ stay free of
// any reference to the clinical UI.

// The shell owns the animation-frame throttle; it decides by mode which
// monitors to paint and this is the clinical half.
on("monitors:tick", () => drawClinicalMonitors());
on("monitors:clear", () => clearClinicalMonitors());

// An exam take finished saving. R&D takes carry no meta and are filtered out
// by the emitter, so anything arriving here belongs to a patient.
on("recording:saved", recording => onClinicalRecordingSaved(recording));

// Takes were restored from storage: the patient list and the chart are derived
// from them and are only correct once they are back.
on("patients:changed", () => void loadClinicalPatients());

// A take was renamed or deleted anywhere in the app; the chart shows takes.
on("library:changed", () => renderChart());

// Everything was wiped. The selected patient and session live here, so this
// module clears them rather than having storage reach into its state.
on("data:cleared", () => {
  clinicalPatients = [];
  currentPatient = null;
  currentSessionId = null;
  renderPatientTable();
  renderExamHeader();
  renderChart();
});

/**
 * Read access to the clinical state for the browser smoke suite, which drives
 * the app over the DevTools Protocol and has no other handle on module scope.
 * Exposed through devtools.ts, not as globals.
 */
export const clinicalStateAccess = {
  get patients(): StoredPatient[] { return clinicalPatients; },
  set patients(value: StoredPatient[]) { clinicalPatients = value; },
  get patient(): StoredPatient | null { return currentPatient; },
  set patient(value: StoredPatient | null) { currentPatient = value; },
  get sessionId(): string | null { return currentSessionId; },
  set sessionId(value: string | null) { currentSessionId = value; },
};
