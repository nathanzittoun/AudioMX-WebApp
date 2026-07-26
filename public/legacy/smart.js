// SMART on FHIR client (Phase 3a) — standalone launch, public client + PKCE.
//
// This is the "login" layer that lets AudioMX connect to a real FHIR server
// (e.g. Epic's sandbox), authenticate, and read/write a patient's chart.
// It is a browser-only flow: PKCE (Proof Key for Code Exchange) makes the
// OAuth handshake secure without any backend or client secret, which suits a
// static site hosted on GitHub Pages.
//
// Flow:
//   1. smartLaunch()          → discover Epic's auth endpoints, build a PKCE
//                               challenge, redirect the browser to Epic login.
//   2. (user logs in on Epic, picks a patient, approves scopes)
//   3. Epic redirects back with ?code=… → smartHandleRedirect() exchanges the
//      code for an access token (proving possession of the PKCE verifier).
//   4. smartFetch()/smartWriteObservation() call the FHIR API with the token.
//
// SECURITY NOTE: this is a sandbox/research starting point. Real PHI use needs
// the Phase 4 items (backend token handling, audit, BAA) — do not point this
// at production patient data as-is.

const SMART = {
  // ---- EDIT AFTER REGISTERING ON fhir.epic.com --------------------------
  // Epic app NON-PRODUCTION Client ID (public client — not a secret; it also
  // travels in the login URL). Swap for the Production Client ID when going live.
  clientId: "05b94f6d-d653-4db8-abc2-5a750eea6df6",

  // Epic's public R4 sandbox FHIR base (the "aud"/"iss"). Leave as-is for the
  // Epic sandbox; swap for WCM's real FHIR base later.
  iss: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",

  // The redirect URI Epic sends you back to. PINNED to one fixed URL so it
  // can't drift with how the page is opened — a mismatch is exactly what
  // triggers Epic's "The request is invalid". Register this EXACT string on
  // Epic. Epic will send you back here (the app root serves index.html, which
  // loads ehr.js and finishes the login), no matter which page you launched from.
  redirectUri: "https://nathanzittoun.github.io/esp32-usb-mic-control/",

  // What we ask permission to do — must line up with the scopes registered on
  // Epic. Reading Patient + Observation is the proof; DocumentReference is the
  // supported write path (Epic doesn't allow writing custom Observations).
  scope: "openid fhirUser launch/patient patient/Patient.read patient/Observation.read patient/DocumentReference.read patient/DocumentReference.write"
};

// In-memory session once connected: { accessToken, patient, tokenType, fhirBase }
let smartSession = null;

// ---- helpers -----------------------------------------------------------

function smartBase() { return SMART.iss.replace(/\/+$/, ""); }

function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafe(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return b64url(a);
}

// Build a PKCE verifier + S256 challenge pair.
async function smartPkce() {
  const verifier = randomUrlSafe(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier: verifier, challenge: b64url(digest) };
}

// Read the server's SMART configuration to find its authorize/token URLs.
async function smartDiscover() {
  const res = await fetch(smartBase() + "/.well-known/smart-configuration", {
    headers: { Accept: "application/json" }
  });
  if (!res.ok) throw new Error("SMART discovery failed (" + res.status + ")");
  return res.json(); // { authorization_endpoint, token_endpoint, ... }
}

// ---- step 1: start the login -------------------------------------------

// True when the page is being served from where the pinned redirect points,
// so Epic will accept the round-trip. Launching from file:// or 127.0.0.1
// (Live Server) sends a redirect Epic doesn't know and fails with
// "The request is invalid".
function smartOriginOk() {
  try { return SMART.redirectUri.indexOf(location.origin + location.pathname) === 0 ||
               SMART.redirectUri === location.origin + "/"; }
  catch (e) { return false; }
}

async function smartLaunch() {
  if (!SMART.clientId || SMART.clientId.indexOf("PASTE_") === 0) {
    throw new Error("Set SMART.clientId to your Epic non-production Client ID first.");
  }
  // Warn early if the current page can't be the redirect target — otherwise
  // Epic just shows an opaque "request is invalid" after the user logs in.
  if (location.protocol === "file:" || /^(127\.0\.0\.1|localhost)/.test(location.host)) {
    throw new Error("Open the app at " + SMART.redirectUri +
      " (not a local/Live Server URL) — Epic only accepts the registered address.");
  }

  const cfg = await smartDiscover();
  const { verifier, challenge } = await smartPkce();
  const state = randomUrlSafe(16);

  sessionStorage.setItem("smart_verifier", verifier);
  sessionStorage.setItem("smart_state", state);
  sessionStorage.setItem("smart_token_endpoint", cfg.token_endpoint);

  const q = new URLSearchParams({
    response_type: "code",
    client_id: SMART.clientId,
    redirect_uri: SMART.redirectUri,
    scope: SMART.scope,
    state: state,
    aud: SMART.iss,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  const authUrl = cfg.authorization_endpoint + "?" + q.toString();
  // Log the exact request so a redirect mismatch is easy to spot in the console.
  if (window.console) console.log("[SMART] redirect_uri =", SMART.redirectUri, "\n[SMART] authorize =", authUrl);
  location.assign(authUrl);
}

// ---- step 3: handle the redirect back ----------------------------------
// Returns true if we completed a login on this page load.

async function smartHandleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;

  if (params.get("error")) {
    throw new Error("Epic returned an error: " + params.get("error") +
      " — " + (params.get("error_description") || ""));
  }
  if (params.get("state") !== sessionStorage.getItem("smart_state")) {
    throw new Error("State mismatch (possible CSRF) — aborting.");
  }

  const verifier = sessionStorage.getItem("smart_verifier");
  const tokenEndpoint = sessionStorage.getItem("smart_token_endpoint");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: SMART.redirectUri,
    client_id: SMART.clientId,
    code_verifier: verifier
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body
  });
  const tok = await res.json();
  if (!res.ok || !tok.access_token) {
    throw new Error("Token exchange failed: " + (tok.error_description || tok.error || res.status));
  }

  smartSession = {
    accessToken: tok.access_token,
    patient: tok.patient || null,
    tokenType: tok.token_type || "Bearer",
    fhirBase: SMART.iss
  };

  // Strip ?code=… from the address bar so a refresh doesn't re-run it.
  history.replaceState({}, "", SMART.redirectUri);
  return true;
}

function smartIsConnected() { return !!(smartSession && smartSession.accessToken); }

// ---- step 4: call the FHIR API -----------------------------------------

async function smartFetch(path, opts) {
  if (!smartIsConnected()) throw new Error("Not connected to a FHIR server.");
  opts = opts || {};
  const res = await fetch(smartBase() + "/" + path.replace(/^\/+/, ""), {
    method: opts.method || "GET",
    headers: Object.assign({
      Authorization: smartSession.tokenType + " " + smartSession.accessToken,
      Accept: "application/fhir+json"
    }, opts.headers || {}),
    body: opts.body
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error("FHIR " + res.status + ": " + (json.issue && json.issue[0] && json.issue[0].diagnostics || text));
  return json;
}

// Load the patient chosen during launch.
async function smartLoadPatient() {
  if (!smartSession.patient) throw new Error("No patient in launch context.");
  return smartFetch("Patient/" + smartSession.patient);
}

// List the patient's Observations. Epic requires a `category` on the search
// (a bare patient search returns "Must have either code or category"), so we
// try labs first, then vital signs.
async function smartListObservations() {
  for (const category of ["laboratory", "vital-signs"]) {
    const bundle = await smartFetch("Observation?patient=" +
      encodeURIComponent(smartSession.patient) + "&category=" + category + "&_count=20");
    if (bundle.entry && bundle.entry.length) return bundle;
  }
  return { resourceType: "Bundle", type: "searchset", total: 0, entry: [] };
}

// Write one Observation into the chart. NOTE: Epic forbids writing custom
// Observations (returns 403) — only recognized Vital Signs are writable — so
// for voice biomarkers use smartWriteDocumentReference() instead.
async function smartWriteObservation(observation) {
  const obs = Object.assign({}, observation, {
    subject: { reference: "Patient/" + smartSession.patient }
  });
  return smartFetch("Observation", {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(obs)
  });
}

// Write a voice-analysis note into the chart as a DocumentReference — the
// path Epic actually supports for novel data. `text` is the report body.
// (Epic may still require an encounter/clinician context in some configs;
//  standalone patient launch can be restricted — treat this as best-effort.)
async function smartWriteDocumentReference(text) {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  const doc = {
    resourceType: "DocumentReference",
    status: "current",
    docStatus: "final",
    type: {
      coding: [{ system: "http://loinc.org", code: "34117-2", display: "History and physical note" }],
      text: "AudioMX voice acoustic analysis"
    },
    subject: { reference: "Patient/" + smartSession.patient },
    content: [{ attachment: { contentType: "text/plain", data: b64, title: "AudioMX voice acoustic analysis" } }]
  };
  return smartFetch("DocumentReference", {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(doc)
  });
}
