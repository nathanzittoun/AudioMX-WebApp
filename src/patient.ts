// Runs inside the popped-out patient window (patient.html). It renders the
// patient-facing prompt and stays in sync with the clinician dashboard over a
// BroadcastChannel — no shared scope, just messages.
//
// Its own Vite entry, separate from index.html: this window shares nothing with
// the clinician app except the protocol definition and these messages.

import { getProtocolTest } from "./core/protocol";

type PatientMessage =
  | { kind: "test"; testId: string }
  | { kind: "go"; on: boolean }
  | { kind: "countdown"; seconds: number }
  | { kind: "timerStart"; seconds: number | null }
  | { kind: "timerStop" }
  | { kind: "ready" };

interface PatientSnapshot {
  testId?: string;
  go?: boolean;
  last?: PatientMessage;
}

const patientChannel = new BroadcastChannel("audiomx-patient");

let pwTimer: number | null = null;
let pwTimerStart = 0;
let pwTimerDuration = 0;

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`patient.html is missing #${id}`);
  return node;
};

const pwIcon = el("pTaskIcon");
const pwTitle = el("pTaskTitle");
const pwSteps = el("pSteps");
const pwReads = el("pReads");
const pwGoBar = el("pGoBar");
const pwTimerBar = el("pTimerBar");
const pwTimerWrap = el("pTimerWrap");

function pwRenderTest(testId: string): void {
  const test = getProtocolTest(testId);
  if (!test) return;

  pwIcon.textContent = test.icon;
  pwTitle.textContent = test.patientTitle;

  pwSteps.innerHTML = "";
  for (const step of test.patientSteps) {
    const li = document.createElement("li");
    li.textContent = step;
    pwSteps.appendChild(li);
  }

  pwReads.innerHTML = "";
  if (test.reads) {
    for (const line of test.reads) {
      const p = document.createElement("p");
      p.className = "patientReadLine";
      p.textContent = line;
      pwReads.appendChild(p);
    }
    pwReads.style.display = "block";
  } else {
    pwReads.style.display = "none";
  }
}

function pwSetGo(on: boolean): void {
  pwGoBar.classList.toggle("go", on);
  pwGoBar.textContent = on ? "● Recording — begin speaking" : "Get ready…";
}

function pwStartTimer(seconds: number | null): void {
  pwStopTimer();
  pwTimerWrap.style.display = "block";
  pwTimerStart = performance.now();
  pwTimerDuration = seconds ? seconds * 1000 : 0;

  pwTimer = window.setInterval(() => {
    const elapsed = performance.now() - pwTimerStart;
    if (pwTimerDuration > 0) {
      pwTimerBar.style.width = Math.max(0, 1 - elapsed / pwTimerDuration) * 100 + "%";
    } else {
      pwTimerBar.style.width = Math.min(100, (elapsed / 60000) * 100) + "%";
    }
  }, 100);
}

function pwStopTimer(): void {
  if (pwTimer !== null) {
    clearInterval(pwTimer);
    pwTimer = null;
  }
  pwTimerBar.style.width = "100%";
}

let pwGotState = false;

function pwHandle(m: PatientMessage | null | undefined): void {
  if (!m) return;
  if (m.kind === "test") { pwGotState = true; pwRenderTest(m.testId); }
  else if (m.kind === "go") { pwGotState = true; pwSetGo(m.on); }
  else if (m.kind === "countdown") { pwGotState = true; pwCountdown(m.seconds); }
  else if (m.kind === "timerStart") pwStartTimer(m.seconds);
  else if (m.kind === "timerStop") pwStopTimer();
}

// "Get ready" countdown: grey go-bar + green timer bar sliding to empty.
function pwCountdown(seconds: number): void {
  pwGoBar.classList.remove("go");
  pwGoBar.textContent = "Get ready…";
  pwStartTimer(seconds);
}

// Apply a full snapshot (from localStorage).
function pwApplyState(st: PatientSnapshot | null): void {
  if (!st) return;
  pwGotState = true;
  if (st.testId) pwRenderTest(st.testId);
  pwSetGo(!!st.go);
  if (st.last && st.last.kind === "countdown") pwCountdown(st.last.seconds);
  else if (st.last && st.last.kind === "timerStart") pwStartTimer(st.last.seconds);
  else if (st.last && st.last.kind === "timerStop") pwStopTimer();
}

// Transport 1+2: BroadcastChannel + postMessage from the opener.
patientChannel.onmessage = event => pwHandle(event.data as PatientMessage);
window.addEventListener("message", event => pwHandle(event.data as PatientMessage));

// Transport 3 (most reliable, same origin): localStorage. Read the current
// state immediately on load, then follow live updates via storage events.
try {
  const snapshot = localStorage.getItem("audiomx-patient");
  if (snapshot) pwApplyState(JSON.parse(snapshot) as PatientSnapshot);
} catch (e) { /* ignore */ }

window.addEventListener("storage", event => {
  if (event.key === "audiomx-patient" && event.newValue) {
    try { pwApplyState(JSON.parse(event.newValue) as PatientSnapshot); } catch (e) { /* ignore */ }
  }
});

// Ask the clinician dashboard for the current state, retrying until it answers.
let pwReadyTries = 0;
function pwRequestState(): void {
  if (pwGotState || pwReadyTries > 40) return;
  pwReadyTries++;
  patientChannel.postMessage({ kind: "ready" });
  if (window.opener) {
    try { (window.opener as Window).postMessage({ kind: "ready" }, "*"); } catch (e) { /* ignore */ }
  }
  setTimeout(pwRequestState, 300);
}
pwRequestState();

// If nothing arrives after a few seconds, tell the operator why.
setTimeout(() => {
  if (!pwGotState) {
    pwTitle.textContent = "Not receiving from the clinician";
    pwSteps.innerHTML =
      "<li>Open this window from the clinician's <b>“Open patient view ↗”</b> button.</li>" +
      "<li>Keep the clinician app and this window on the <b>same address</b> (both 127.0.0.1 or both localhost).</li>" +
      "<li>Then hard-refresh this window: <b>Cmd/Ctrl + Shift + R</b>.</li>";
    pwReads.style.display = "none";
  }
}, 3500);
