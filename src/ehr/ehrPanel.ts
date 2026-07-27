// The Epic panel in the Clinical area — bridges the SMART client into the UI so
// a clinician can connect, pull the patient's chart, and later file results.
//
// Standalone launch: "Connect to Epic" redirects the whole page to Epic's login
// and back. On return the handshake is finished here and the patient shown.
// Read-only for now, which is the part Epic fully supports from this launch
// type.

import { el } from "../ui/dom";
import { redirectUri } from "./config";
import { handleRedirect, launch, listObservations, loadPatient } from "./smart";

/** The slice of a FHIR Patient this panel displays. */
interface FhirPatient {
  id: string;
  gender?: string;
  birthDate?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
}

interface FhirObservation {
  resourceType: string;
  code?: { text?: string; coding?: Array<{ display?: string }> };
  valueQuantity?: { value: number; unit?: string };
  valueString?: string;
  effectiveDateTime?: string;
}

function setStatusText(text: string, kind?: "ok" | "err"): void {
  const node = el("cEhrStatus");
  if (!node) return;
  node.textContent = text;
  node.className = "clinEhrStatus" + (kind ? " " + kind : "");
}

export function patientDisplayName(p: FhirPatient): string {
  const n = p.name?.[0];
  if (!n) return p.id;
  return n.text || [(n.given ?? []).join(" "), n.family].filter(Boolean).join(" ") || p.id;
}

/**
 * Show the exact redirect URI, so a mismatch with the Epic registration is
 * visible before the clinician clicks — Epic reports it only as an opaque
 * "request is invalid", after the login.
 */
export function renderEhrHint(): void {
  const hint = el("cEhrHint");
  if (!hint) return;

  // The URI follows wherever the app is served, so localhost is a valid target
  // once registered. Only file:// can never work.
  if (location.protocol === "file:") {
    hint.className = "clinEhrHint warn";
    hint.textContent = "⚠ Open the app over http(s) (npm run dev) — a file:// " +
      "URL cannot be an OAuth redirect target.";
  } else {
    hint.className = "clinEhrHint";
    hint.textContent = "Sign-in returns to " + redirectUri() +
      " — this exact URL must be registered on Epic.";
  }
}

export async function initEhr(): Promise<void> {
  el("cEhrConnect")?.addEventListener("click", () => void connectEhr());
  el("cEhrPull")?.addEventListener("click", () => void pullEhrChart());
  renderEhrHint();

  // If Epic has just redirected back (the URL carries ?code=…), finish the
  // login and put the clinician on the Exam tab, where this panel lives.
  try {
    if (await handleRedirect()) {
      setAppMode("clinical");
      setClinicalTab("exam");
      await afterEhrConnected();
    }
  } catch (e) {
    const message = (e as Error).message;
    setStatusText("Error: " + message, "err");
    log("EHR error: " + message);
  }
}

export async function connectEhr(): Promise<void> {
  try {
    setStatusText("Redirecting to Epic…");
    await launch(); // navigates away to Epic
  } catch (e) {
    setStatusText("Error: " + (e as Error).message, "err");
  }
}

async function afterEhrConnected(): Promise<void> {
  setStatusText("✓ Connected", "ok");

  const connect = el("cEhrConnect");
  if (connect) connect.textContent = "Reconnect";
  const pull = el("cEhrPull");
  if (pull) pull.style.display = "";

  const box = el("cEhrPatient");
  if (!box) return;

  try {
    const p = await loadPatient<FhirPatient>();
    const name = patientDisplayName(p);
    box.innerHTML =
      "<strong>" + name + "</strong> · " + (p.gender || "?") +
      " · DOB " + (p.birthDate || "?") +
      " <span class='ehrId'>Epic id " + p.id + "</span>";
    log("EHR: connected to Epic, loaded " + name + ".");
  } catch (e) {
    // Connected but unable to read: worth distinguishing, since the fix is a
    // scope or launch-context problem rather than a login one.
    box.textContent = "Connected, but could not load patient: " + (e as Error).message;
  }
}

export async function pullEhrChart(): Promise<void> {
  const box = el("cEhrObs");
  if (!box) return;

  box.innerHTML = "<div class='empty'>Loading observations from Epic…</div>";

  try {
    const bundle = await listObservations();
    const entries = ((bundle.entry ?? []) as Array<{ resource?: FhirObservation }>)
      .map(e => e.resource)
      .filter((o): o is FhirObservation => o?.resourceType === "Observation");

    if (!entries.length) {
      box.innerHTML = "<div class='empty'>No lab/vital observations found for this patient.</div>";
      return;
    }

    const items = entries.map(o => {
      const label = o.code?.text || o.code?.coding?.[0]?.display || "Observation";
      const value = o.valueQuantity
        ? o.valueQuantity.value + (o.valueQuantity.unit ? " " + o.valueQuantity.unit : "")
        : (o.valueString ?? "");
      const when = o.effectiveDateTime
        ? new Date(o.effectiveDateTime).toLocaleDateString()
        : "";
      return "<li><strong>" + label + "</strong>: " + value +
        (when ? " <span class='ehrObsDate'>(" + when + ")</span>" : "") + "</li>";
    });

    box.innerHTML = "<div class='ehrObsHead'>" + entries.length +
      " observation(s) from Epic</div><ul class='ehrObsList'>" + items.join("") + "</ul>";
  } catch (e) {
    box.innerHTML = "<div class='empty'>Could not read observations: " + (e as Error).message + "</div>";
  }
}
