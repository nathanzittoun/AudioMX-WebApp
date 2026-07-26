// Clinical section — organized like a small clinical app:
//   • Patients tab: a searchable patient database.
//   • Exam tab: run the protocol for the selected patient (live monitors,
//     connect state, quality gate, patient prompt + pop-out).
//   • Chart tab: the patient's sessions as collapsible folders of takes.
// Takes are filed under the patient/session, kept here (not the R&D Library),
// and persisted in IndexedDB.

let clinicalPatients = [];
let currentPatient = null;
let currentSessionId = null;
let clinicalNotes = "";
let clinicalCurrentTest = PROTOCOL_TESTS[0];
let clinicalConnectKind = null;

let clinicalTimer = null;
let clinicalTimerStart = 0;
let clinicalTimerDuration = 0;
let lastClinicalRecording = null;

// Seconds of "get ready" countdown shown to the patient before recording.
const READY_SECONDS = 5;
let clinicalPhase = "idle"; // "idle" | "ready" | "recording"

// Two transports to the pop-out patient window (patient.html): BroadcastChannel
// (same origin) and direct postMessage to the opened window (crosses origins).
const clinicalChannel = "BroadcastChannel" in window ? new BroadcastChannel("audiomx-patient") : null;
let patientWindowRef = null;

// A snapshot of what the patient should be showing. Mirrored to localStorage so
// the pop-out reads the current state the instant it loads (no handshake race).
const patientState = { testId: PROTOCOL_TESTS[0].id, go: false, last: null };

function broadcastPatient(msg) {
  if (msg.kind === "test") patientState.testId = msg.testId;
  if (msg.kind === "go") patientState.go = msg.on;
  patientState.last = msg;

  if (clinicalChannel) clinicalChannel.postMessage(msg);
  if (patientWindowRef && !patientWindowRef.closed) {
    try { patientWindowRef.postMessage(msg, "*"); } catch (e) { /* ignore */ }
  }
  try {
    localStorage.setItem("audiomx-patient", JSON.stringify({ ...patientState, seq: Date.now() }));
  } catch (e) { /* ignore */ }
}

// ---- Direct control of the pop-out window (most reliable path) ----------
// Because the pop-out is same-origin and we hold its window handle, the
// clinician page can write straight into its DOM — no messaging needed.

function patientDoc() {
  try {
    if (patientWindowRef && !patientWindowRef.closed &&
        patientWindowRef.document &&
        patientWindowRef.document.getElementById("pTaskTitle")) {
      return patientWindowRef.document;
    }
  } catch (e) { /* cross-origin or not ready */ }
  return null;
}

function pushPromptToPopup() {
  const doc = patientDoc();
  if (!doc) return;
  const t = clinicalCurrentTest;
  doc.getElementById("pTaskIcon").textContent = t.icon;
  doc.getElementById("pTaskTitle").textContent = t.patientTitle;
  const steps = doc.getElementById("pSteps");
  steps.innerHTML = "";
  t.patientSteps.forEach(s => { const li = doc.createElement("li"); li.textContent = s; steps.appendChild(li); });
  const reads = doc.getElementById("pReads");
  reads.innerHTML = "";
  if (t.reads) {
    t.reads.forEach(l => { const p = doc.createElement("p"); p.className = "patientReadLine"; p.textContent = l; reads.appendChild(p); });
    reads.style.display = "block";
  } else {
    reads.style.display = "none";
  }
}

function pushGoToPopup(on) {
  const doc = patientDoc();
  if (!doc) return;
  const go = doc.getElementById("pGoBar");
  go.classList.toggle("go", on);
  go.textContent = on ? "● Recording — begin speaking" : "Get ready…";
}

function pushTimerToPopup(widthPct, visible) {
  const doc = patientDoc();
  if (!doc) return;
  doc.getElementById("pTimerWrap").style.display = visible ? "block" : "none";
  doc.getElementById("pTimerBar").style.width = widthPct + "%";
}

// Big countdown number on both patient screens.
function setCountNumber(text) {
  const el = document.getElementById("pCountNumber");
  if (el) el.textContent = text;
  const doc = patientDoc();
  if (doc) {
    const e2 = doc.getElementById("pCountNumber");
    if (e2) e2.textContent = text;
  }
}

// Short beep (WebAudio).
function clinicalBeep(freq, ms) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq || 880;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (ms || 150) / 1000);
    o.start();
    o.stop(ctx.currentTime + (ms || 150) / 1000);
    o.onended = () => { try { ctx.close(); } catch (e) {} };
  } catch (e) { /* ignore */ }
}

// Read the current task aloud (browser TTS) if the toggle is on.
function speakCurrentPrompt() {
  const speak = document.getElementById("cSpeak");
  if (!speak || !speak.checked || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const t = clinicalCurrentTest;
    const u = new SpeechSynthesisUtterance(t.patientTitle + ". " + t.patientSteps.join(". "));
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}

// ---- Patient "I'm ready" gate ------------------------------------------
// After the instructions are read, the patient (or clinician) presses a
// button to confirm they're ready. Only then does the countdown + recording
// start. The button lives on both the clinician's embedded patient panel and
// the pop-out; we wire its onclick straight to onPatientReady (the reliable
// direct-DOM path — no cross-window messaging needed).

function showReadyGate(on) {
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

function onPatientReady() {
  if (clinicalPhase !== "waiting") return;
  try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  showReadyGate(false);
  beginCountdownAndRecord();
}

// Countdown, then start recording. Auto-stops at the test's hold duration
// (or runs until the clinician ends it, for open-ended tasks).
function beginCountdownAndRecord() {
  broadcastPatient({ kind: "countdown", seconds: READY_SECONDS });
  clinicalPhase = "ready";
  runGetReady(READY_SECONDS, async () => {
    if (clinicalPhase !== "ready") return; // cancelled during countdown
    clinicalPhase = "recording";
    setPatientRecording(true);
    await startRecording();
    startClinicalTimer(clinicalCurrentTest.holdSeconds);
  });
}

// After a good take, advance to the next protocol test automatically.
function advanceProtocol() {
  const idx = PROTOCOL_TESTS.findIndex(t => t.id === clinicalCurrentTest.id);
  if (idx >= 0 && idx < PROTOCOL_TESTS.length - 1) {
    selectClinicalTest(PROTOCOL_TESTS[idx + 1].id);
  }
}

const CONNECT_LABELS = {
  usb: "Connect MEMS (USB)",
  wifi: "Connect MEMS (Wi-Fi)",
  computer: "Connect computer mic"
};
const CONNECT_IDS = { usb: "cConnectUsb", wifi: "cConnectWifi", computer: "cConnectComputer" };

// DOM refs
let cTestList, cStartBtn, cStopBtn, cGateBox, cTestName, cTestNote, cNotesInput;
let cWaveCanvas, cWaveCtx, cSpecCanvas, cSpecCtx;
let cRmsEl, cPeakEl, cClipEl, cLevelBar;
let pTaskTitle, pTaskIcon, pSteps, pReads, pGoBar, pTimerBar, pTimerWrap;
let cPatientTable, cPatientSearch, cExamPatient, cSessionLabel, cChartPatient, cChartFolders;

function initClinical() {
  cTestList = document.getElementById("cTestList");
  cStartBtn = document.getElementById("cStartBtn");
  cStopBtn = document.getElementById("cStopBtn");
  cGateBox = document.getElementById("cGateBox");
  cTestName = document.getElementById("cTestName");
  cTestNote = document.getElementById("cTestNote");
  cNotesInput = document.getElementById("cNotes");

  cWaveCanvas = document.getElementById("cWaveform");
  cWaveCtx = cWaveCanvas ? cWaveCanvas.getContext("2d") : null;
  cSpecCanvas = document.getElementById("cSpectrum");
  cSpecCtx = cSpecCanvas ? cSpecCanvas.getContext("2d") : null;

  cRmsEl = document.getElementById("cRms");
  cPeakEl = document.getElementById("cPeak");
  cClipEl = document.getElementById("cClip");
  cLevelBar = document.getElementById("cLevelBar");

  pTaskTitle = document.getElementById("pTaskTitle");
  pTaskIcon = document.getElementById("pTaskIcon");
  pSteps = document.getElementById("pSteps");
  pReads = document.getElementById("pReads");
  pGoBar = document.getElementById("pGoBar");
  pTimerBar = document.getElementById("pTimerBar");
  pTimerWrap = document.getElementById("pTimerWrap");

  cPatientTable = document.getElementById("cPatientTable");
  cPatientSearch = document.getElementById("cPatientSearch");
  cExamPatient = document.getElementById("cExamPatient");
  cSessionLabel = document.getElementById("cSessionLabel");
  cChartPatient = document.getElementById("cChartPatient");
  cChartFolders = document.getElementById("cChartFolders");

  // Sub-tabs
  document.querySelectorAll(".clinTabBtn").forEach(btn => {
    btn.addEventListener("click", () => setClinicalTab(btn.dataset.ctab));
  });

  renderClinicalTestList();
  selectClinicalTest(PROTOCOL_TESTS[0].id);

  cStartBtn.addEventListener("click", startClinicalTest);
  cStopBtn.addEventListener("click", stopClinicalTest);
  cNotesInput.addEventListener("input", () => { clinicalNotes = cNotesInput.value; });

  document.getElementById("cNewPatientBtn").addEventListener("click", createNewPatient);
  document.getElementById("cNewSessionBtn").addEventListener("click", startNewSession);
  cPatientSearch.addEventListener("input", () => renderPatientTable());

  document.getElementById("cConnectUsb").addEventListener("click", () => clinicalConnect("usb"));
  document.getElementById("cConnectWifi").addEventListener("click", () => clinicalConnect("wifi"));
  document.getElementById("cConnectComputer").addEventListener("click", () => clinicalConnect("computer"));
  document.getElementById("cPopoutBtn").addEventListener("click", openPatientView);
  document.getElementById("cExportPatientBtn").addEventListener("click", downloadPatientAll);
  const fhirBtn = document.getElementById("cExportFhirBtn");
  if (fhirBtn) fhirBtn.addEventListener("click", downloadPatientFhir);

  // Space toggles Start/End while in the Exam tab (not while typing).
  window.addEventListener("keydown", event => {
    if (event.code !== "Space") return;
    if (appMode !== "clinical") return;
    if (document.getElementById("clinExam").hidden) return;
    const tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    event.preventDefault();
    if (clinicalPhase === "idle") startClinicalTest();
    else if (clinicalPhase === "waiting") onPatientReady();
    else stopClinicalTest();
  });

  const handleReady = data => {
    if (data && data.kind === "ready") {
      broadcastPatient({ kind: "test", testId: clinicalCurrentTest.id });
      broadcastPatient({ kind: "go", on: isRecording });
    }
  };
  if (clinicalChannel) clinicalChannel.onmessage = event => handleReady(event.data);
  window.addEventListener("message", event => handleReady(event.data));

  clearClinicalMonitors();
  updateClinicalConnectState();
  loadClinicalPatients();
  setClinicalTab("patients");
}

function setClinicalTab(name) {
  document.querySelectorAll(".clinTabBtn").forEach(b => b.classList.toggle("active", b.dataset.ctab === name));
  document.getElementById("clinPatients").hidden = name !== "patients";
  document.getElementById("clinExam").hidden = name !== "exam";
  document.getElementById("clinChart").hidden = name !== "chart";
  if (name === "chart") renderChart();
  if (name === "exam") renderExamHeader();
}

// ---- Connection --------------------------------------------------------

async function clinicalConnect(kind) {
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

function updateClinicalConnectState() {
  for (const k in CONNECT_IDS) {
    const b = document.getElementById(CONNECT_IDS[k]);
    if (!b) continue;
    b.classList.remove("primaryBtn");
    b.classList.add("secondaryBtn");
    b.textContent = CONNECT_LABELS[k];
  }
  if (isConnected && clinicalConnectKind) {
    const b = document.getElementById(CONNECT_IDS[clinicalConnectKind]);
    if (b) {
      b.classList.remove("secondaryBtn");
      b.classList.add("primaryBtn");
      b.textContent = "✓ Connected — " + CONNECT_LABELS[clinicalConnectKind].replace("Connect ", "");
    }
  }
}

// ---- Patient database --------------------------------------------------

async function loadClinicalPatients() {
  clinicalPatients = await loadPatientsFromDb();
  const known = new Set(clinicalPatients.map(p => p.id));
  for (const r of recordings) {
    if (r.meta && r.meta.patientId && !known.has(r.meta.patientId)) {
      known.add(r.meta.patientId);
      clinicalPatients.push({ id: r.meta.patientId, name: r.meta.patientName || "", createdAt: r.createdAt });
    }
  }
  renderPatientTable();
  renderExamHeader();
  renderChart();
}

function patientRecordingCount(id) {
  return recordings.filter(r => r.meta && r.meta.patientId === id).length;
}

function patientLastDate(id) {
  const takes = recordings.filter(r => r.meta && r.meta.patientId === id);
  if (!takes.length) return null;
  return new Date(Math.max(...takes.map(r => r.createdAt)));
}

function demographicsStr(p) {
  if (!p) return "";
  return [p.age ? p.age + " y" : "", p.sex || ""].filter(Boolean).join(", ");
}

function renderPatientTable() {
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

function createNewPatient() {
  const id = (prompt("New patient — Patient ID (e.g. PT-0142):") || "").trim();
  if (!id) return;
  let patient = clinicalPatients.find(p => p.id === id);
  if (!patient) {
    const name = (prompt("Optional patient name / label:") || "").trim();
    const age = (prompt("Age (optional):") || "").trim();
    const sex = (prompt("Sex (M / F / other, optional):") || "").trim();
    patient = { id, name, age, sex, createdAt: new Date() };
    clinicalPatients.push(patient);
    savePatientToDb(patient);
    log("Patient created: " + id);
  }
  renderPatientTable();
  openPatient(id);
}

function openPatient(id) {
  currentPatient = clinicalPatients.find(p => p.id === id) || null;
  currentSessionId = null;
  clinicalConnectKind = clinicalConnectKind; // keep
  renderPatientTable();
  renderExamHeader();
  renderChart();
  setClinicalTab("exam");
}

function deletePatient(id) {
  const count = patientRecordingCount(id);
  if (!confirm("Delete patient " + id + " and their " + count + " recording(s)?")) return;
  recordings.filter(r => r.meta && r.meta.patientId === id).forEach(r => deleteRecording(r.id));
  clinicalPatients = clinicalPatients.filter(p => p.id !== id);
  deletePatientFromDb(id);
  if (currentPatient && currentPatient.id === id) {
    currentPatient = null;
    currentSessionId = null;
  }
  renderPatientTable();
  renderExamHeader();
  renderChart();
}

function startNewSession() {
  if (!currentPatient) {
    alert("Select a patient first (Patients tab).");
    setClinicalTab("patients");
    return;
  }
  currentSessionId = "S-" + Date.now();
  renderExamHeader();
  log("New session started for " + currentPatient.id + ".");
}

function sessionNumberOf(sessionId) {
  if (!currentPatient) return "?";
  const sessions = patientSessions(currentPatient.id);
  const found = sessions.find(s => s.id === sessionId);
  return found ? found.number : sessions.length + 1;
}

function renderExamHeader() {
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

function renderClinicalTestList() {
  cTestList.innerHTML = "";
  for (const test of PROTOCOL_TESTS) {
    const btn = document.createElement("button");
    btn.className = "clinTestBtn";
    btn.dataset.test = test.id;
    btn.innerHTML = "<span class='clinTestIcon'>" + test.icon + "</span><span>" + test.name + "</span>";
    btn.addEventListener("click", () => selectClinicalTest(test.id));
    cTestList.appendChild(btn);
  }
}

function selectClinicalTest(id) {
  if (isRecording) return;
  clinicalCurrentTest = getProtocolTest(id) || PROTOCOL_TESTS[0];
  document.querySelectorAll(".clinTestBtn").forEach(b => b.classList.toggle("active", b.dataset.test === clinicalCurrentTest.id));
  cTestName.textContent = clinicalCurrentTest.name;
  cTestNote.textContent = clinicalCurrentTest.clinicianNote;
  renderPatientPrompt(clinicalCurrentTest);
  pushPromptToPopup();
  broadcastPatient({ kind: "test", testId: clinicalCurrentTest.id });
}

function renderPatientPrompt(test) {
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

async function startClinicalTest() {
  if (!currentPatient) {
    alert("Select a patient first (Patients tab).");
    setClinicalTab("patients");
    return;
  }
  if (!isConnected) {
    setStatus("Connect a microphone first", "idle");
    log("Clinical: connect a microphone before starting a test.");
    return;
  }
  const consent = document.getElementById("cConsent");
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

async function stopClinicalTest() {
  // Cancel if we haven't started recording yet (waiting on the patient's
  // "I'm ready", or mid get-ready countdown).
  if (clinicalPhase === "waiting" || clinicalPhase === "ready") {
    clinicalPhase = "idle";
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
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

function onClinicalRecordingSaved(recording) {
  lastClinicalRecording = recording;
  renderExamHeader();
  renderChart();
  renderPatientTable();
}

function setPatientRecording(on) {
  broadcastPatient({ kind: "go", on: on });
  pushGoToPopup(on);
  if (!pGoBar) return;
  pGoBar.classList.toggle("go", on);
  pGoBar.textContent = on ? "● Recording — begin speaking" : "Get ready…";
}

// Set both timer bars (in-app + pop-out) at once.
function setTimerBars(widthPct, visible) {
  if (pTimerWrap) pTimerWrap.style.display = visible ? "block" : "none";
  if (pTimerBar) pTimerBar.style.width = widthPct + "%";
  pushTimerToPopup(widthPct, visible);
}

// 5-second "get ready" countdown, driven by the clinician (updates both bars).
function runGetReady(seconds, onDone) {
  stopClinicalTimer();
  if (pGoBar) { pGoBar.classList.remove("go"); pGoBar.textContent = "Get ready…"; }
  pushGoToPopup(false);
  const start = performance.now();
  const dur = seconds * 1000;
  setTimerBars(100, true);
  let lastSec = -1;
  clinicalTimer = setInterval(() => {
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
      clinicalBeep(990, 220); // "go" beep
      onDone();
    }
  }, 60);
}

function startClinicalTimer(seconds) {
  stopClinicalTimer();
  clinicalTimerStart = performance.now();
  clinicalTimerDuration = seconds ? seconds * 1000 : 0;
  broadcastPatient({ kind: "timerStart", seconds: seconds });
  setTimerBars(100, true);
  clinicalTimer = setInterval(() => {
    const elapsed = performance.now() - clinicalTimerStart;
    const w = clinicalTimerDuration > 0
      ? Math.max(0, 1 - elapsed / clinicalTimerDuration) * 100
      : Math.min(100, (elapsed / 60000) * 100);
    setTimerBars(w, true);

    // Auto-stop when a fixed-duration task reaches its target.
    if (clinicalTimerDuration > 0 && elapsed >= clinicalTimerDuration && clinicalPhase === "recording") {
      stopClinicalTest();
    }
  }, 100);
}

function stopClinicalTimer() {
  if (clinicalTimer) { clearInterval(clinicalTimer); clinicalTimer = null; }
  broadcastPatient({ kind: "timerStop" });
  setTimerBars(100, true);
}

// ---- Quality gate ------------------------------------------------------

function runClinicalQualityGate() {
  if (!lastClinicalRecording || !lastClinicalRecording.analysisSamples) return;
  const m = clinicalMetricsOf(lastClinicalRecording.analysisSamples);
  const problems = [];
  if (m.clip > 0.5) problems.push("Clipping (" + m.clip.toFixed(1) + "%) — lower gain (raise PCM_SHIFT).");
  if (m.peak > -1) problems.push("Level too hot (peak " + m.peak.toFixed(1) + " dBFS).");
  if (m.rms < -55) problems.push("Very quiet (RMS " + m.rms.toFixed(1) + " dBFS) — move closer or check the mic.");
  if (problems.length === 0) {
    showClinicalGate(true, "Good take — RMS " + m.rms.toFixed(1) + " dBFS, peak " + m.peak.toFixed(1) + " dBFS.", []);
  } else {
    showClinicalGate(false, "Check this recording:", problems);
  }
}

function showClinicalGate(ok, headline, problems) {
  cGateBox.style.display = "block";
  cGateBox.className = "clinGate " + (ok ? "gateOk" : "gateWarn");
  let html = "<div class='gateHead'>" + headline + "</div>";
  if (problems.length) html += "<ul>" + problems.map(p => "<li>" + p + "</li>").join("") + "</ul>";
  html += "<div class='gateBtns'><button id='gateContinue' class='smallBtn'>Continue</button>" +
    "<button id='gateRedo' class='smallBtn deleteBtn'>Record again</button></div>";
  cGateBox.innerHTML = html;
  document.getElementById("gateContinue").addEventListener("click", () => {
    hideClinicalGate();
    if (ok) advanceProtocol(); // good take → move to the next test
  });
  document.getElementById("gateRedo").addEventListener("click", () => {
    if (lastClinicalRecording) { deleteClinicalRecording(lastClinicalRecording.id, true); lastClinicalRecording = null; }
    hideClinicalGate();
  });
}

function hideClinicalGate() {
  if (cGateBox) { cGateBox.style.display = "none"; cGateBox.innerHTML = ""; }
}

// ---- Patient chart: sessions as folders --------------------------------

function patientSessions(patientId) {
  const takes = recordings.filter(r => r.meta && r.meta.patientId === patientId);
  const map = {};
  for (const t of takes) (map[t.meta.sessionId] = map[t.meta.sessionId] || []).push(t);
  const ids = Object.keys(map).sort((a, b) =>
    Math.min(...map[a].map(x => x.createdAt)) - Math.min(...map[b].map(x => x.createdAt)));
  return ids.map((id, i) => ({
    id,
    number: i + 1,
    takes: map[id].sort((a, b) => a.createdAt - b.createdAt),
    date: new Date(Math.min(...map[id].map(x => x.createdAt)))
  }));
}

// ---- Per-patient trend view (features across sessions) -----------------
// For each acoustic measure, average the voiced takes within a session and
// plot one point per session so a clinician can see change over time.

const TREND_METRICS = [
  { key: "f0", label: "F0 (pitch)", unit: "Hz", digits: 0, betterUp: null },
  { key: "hnrDb", label: "HNR", unit: "dB", digits: 1, betterUp: true },
  { key: "jitterPct", label: "Jitter", unit: "%", digits: 2, betterUp: false },
  { key: "shimmerPct", label: "Shimmer", unit: "%", digits: 1, betterUp: false }
];

function sessionFeatureMean(session, key) {
  const vals = session.takes
    .filter(t => t.features && t.features.voiced && isFinite(t.features[key]))
    .map(t => t.features[key]);
  if (!vals.length) return null;
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}

// Tiny inline SVG line chart from a list of {n, v} points.
function trendSparkline(points, betterUp) {
  const W = 240, H = 64, padX = 6, padY = 10;
  if (points.length === 0) return "<svg width='" + W + "' height='" + H + "'></svg>";

  const vs = points.map(p => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;

  const x = i => points.length === 1
    ? W / 2
    : padX + (i / (points.length - 1)) * (W - 2 * padX);
  const y = v => H - padY - ((v - min) / span) * (H - 2 * padY);

  let path = "";
  points.forEach((p, i) => { path += (i === 0 ? "M" : "L") + x(i).toFixed(1) + " " + y(p.v).toFixed(1) + " "; });

  let dots = "";
  points.forEach((p, i) => {
    dots += "<circle cx='" + x(i).toFixed(1) + "' cy='" + y(p.v).toFixed(1) +
      "' r='3' fill='#3b6fb0'></circle>";
  });

  // Colour the trend direction (last vs first) when a direction is "better".
  let stroke = "#3b6fb0";
  if (betterUp !== null && points.length >= 2) {
    const rising = points[points.length - 1].v > points[0].v;
    const good = betterUp ? rising : !rising;
    stroke = good ? "#2e9e5b" : "#c0492f";
  }

  return "<svg width='" + W + "' height='" + H + "' class='trendSvg'>" +
    "<path d='" + path.trim() + "' fill='none' stroke='" + stroke + "' stroke-width='2'></path>" +
    dots + "</svg>";
}

function renderPatientTrends() {
  const box = document.getElementById("cChartTrends");
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
    const points = [];
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

function renderChart() {
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
    sessions.unshift({ id: currentSessionId, number: sessionNumberOf(currentSessionId), takes: [], date: new Date() });
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
      exportBtn.onclick = () => downloadClinicalSession(s.id);
      folder.appendChild(exportBtn);

      for (const r of s.takes) {
        folder.appendChild(renderChartTake(r));
      }
    }
    cChartFolders.appendChild(folder);
  }
}

function renderChartTake(r) {
  const row = document.createElement("div");
  row.className = "chartRow";
  const title = document.createElement("div");
  title.className = "chartRowTitle";
  title.textContent = (r.name || r.meta.testName) + " · " + r.duration.toFixed(2) + " s" +
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

function deleteClinicalRecording(id, skipConfirm) {
  const r = recordings.find(x => x.id === id);
  if (!r) return;
  if (!skipConfirm && !confirm("Delete this recording?")) return;
  deleteRecording(id);
  renderExamHeader();
  renderChart();
  renderPatientTable();
}

// ---- Session export (WAVs + manifest.csv as one ZIP) -------------------

function clinicalMetricsOf(samples) {
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

function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }

const MANIFEST_HEADER = [
  "patient_id", "patient_name", "age", "sex", "session_id", "test_id", "test_name",
  "filename", "custom_name", "filtered", "duration_s",
  "f0_hz", "jitter_pct", "shimmer_pct", "hnr_db", "f1_hz", "f2_hz",
  "rms_dbfs", "peak_dbfs", "clipping_pct", "channels", "sample_rate_hz", "notes", "timestamp"
];

function num(v, d) { return v == null || isNaN(v) ? "" : v.toFixed(d); }

async function exportRecordingsZip(items, zipName) {
  const files = [];
  const rows = [MANIFEST_HEADER.map(csvCell).join(",")];

  for (const r of items) {
    const fname = recordingBaseName(r) + ".wav";
    files.push({ name: fname, data: new Uint8Array(await r.blob.arrayBuffer()) });

    const m = clinicalMetricsOf(r.analysisSamples);
    const f = r.features || {};
    const patient = clinicalPatients.find(p => r.meta && p.id === r.meta.patientId) || {};

    rows.push([
      r.meta.patientId, r.meta.patientName || "", patient.age || "", patient.sex || "",
      r.meta.sessionId, r.meta.testId, r.meta.testName, fname, r.name || "",
      r.filtered ? "yes" : "no", r.duration.toFixed(3),
      num(f.f0, 1), num(f.jitterPct, 3), num(f.shimmerPct, 2), num(f.hnrDb, 1),
      f.f1 || "", f.f2 || "",
      m.rms.toFixed(1), m.peak.toFixed(1), m.clip.toFixed(2), r.channels, SAMPLE_RATE,
      r.meta.notes || "", r.createdAt.toISOString()
    ].map(csvCell).join(","));
  }

  files.push({ name: "manifest.csv", data: new TextEncoder().encode(rows.join("\n")) });
  const zip = createZip(files);
  const url = URL.createObjectURL(zip);
  triggerDownload(url, zipName);
  URL.revokeObjectURL(url);
}

async function downloadClinicalSession(sessionId) {
  const items = recordings.filter(r => r.meta && r.meta.sessionId === sessionId);
  if (items.length === 0) { alert("No recordings in this session."); return; }
  await exportRecordingsZip(items, "AudioMX_" + sanitizeForFilename(sessionId) + ".zip");
  log("Session exported: " + items.length + " take(s) + manifest.csv.");
}

async function downloadPatientAll() {
  if (!currentPatient) { alert("Open a patient first."); return; }
  const items = recordings.filter(r => r.meta && r.meta.patientId === currentPatient.id);
  if (items.length === 0) { alert("No recordings for this patient."); return; }
  await exportRecordingsZip(items, "AudioMX_patient_" + sanitizeForFilename(currentPatient.id) + ".zip");
  log("Patient export: " + items.length + " take(s) across all sessions.");
}

// ---- Pop-out patient window --------------------------------------------

function openPatientView() {
  // ?v= busts the browser cache so the window always loads the newest code.
  patientWindowRef = window.open("patient.html?v=" + Date.now(), "audiomxPatient", "width=1024,height=768");

  // Directly write the current prompt into the pop-out as soon as it is ready.
  // Poll for a couple of seconds since onload timing varies.
  let tries = 0;
  const push = () => {
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

function clearClinicalMonitors() {
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

function drawClinicalMonitors() {
  drawClinicalWaveform();
  drawClinicalSpectrum();
  updateClinicalMetrics(liveSamples);
}

function drawClinicalWaveform() {
  if (!cWaveCtx) return;
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
  if (liveSamples.length < 2) return;
  cWaveCtx.strokeStyle = "#3b6fb0";
  cWaveCtx.lineWidth = 2;
  cWaveCtx.beginPath();
  const step = Math.max(1, Math.floor(liveSamples.length / w));
  let x = 0;
  for (let i = 0; i < liveSamples.length; i += step) {
    const y = h / 2 - (liveSamples[i] / 32768) * h * 0.42;
    if (x === 0) cWaveCtx.moveTo(x, y); else cWaveCtx.lineTo(x, y);
    x++;
    if (x >= w) break;
  }
  cWaveCtx.stroke();
}

function drawClinicalSpectrum() {
  if (!cSpecCtx) return;
  const w = cSpecCanvas.width, h = cSpecCanvas.height;
  cSpecCtx.fillStyle = "#f0f0f2";
  cSpecCtx.fillRect(0, 0, w, h);
  const n = Math.min(liveSamples.length, 4096);
  if (n < 512) return;
  const spectrum = computeSpectrum(Int16Array.from(liveSamples.slice(liveSamples.length - n)));
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
  cSpecCtx.strokeStyle = "#3b6fb0";
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

function updateClinicalMetrics(samples) {
  if (!samples || samples.length === 0 || !cRmsEl) return;
  const m = clinicalMetricsOf(Int16Array.from(samples));
  cRmsEl.textContent = m.rms.toFixed(1) + " dBFS";
  cPeakEl.textContent = m.peak.toFixed(1) + " dBFS";
  cClipEl.textContent = m.clip.toFixed(2) + "%";
  cLevelBar.style.width = clamp(((m.rms + 80) / 80) * 100, 0, 100) + "%";
}
