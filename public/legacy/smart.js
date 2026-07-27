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

// The directory the app is served from, always ending in "/". Dropping the
// trailing filename means index.html, patient.html and a bare directory URL all
// collapse to the same value, which is what Epic has registered.
//   /AudioMX-WebApp/index.html -> /AudioMX-WebApp/
//   /AudioMX-WebApp/           -> /AudioMX-WebApp/
//   /                          -> /
function smartAppRoot() {
  return location.origin + location.pathname.replace(/[^/]*$/, "");
}

const SMART = {
  // ---- EDIT AFTER REGISTERING ON fhir.epic.com --------------------------
  // Epic app NON-PRODUCTION Client ID (public client — not a secret; it also
  // travels in the login URL). Swap for the Production Client ID when going live.
  clientId: "05b94f6d-d653-4db8-abc2-5a750eea6df6",

  // Epic's public R4 sandbox FHIR base (the "aud"/"iss"). Leave as-is for the
  // Epic sandbox; swap for WCM's real FHIR base later.
  iss: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",

  // The redirect URI Epic sends you back to. Derived from where the page is
  // actually served rather than pinned, so dev (http://localhost:5173/) and
  // prod (the Pages URL) each hand Epic their own registered address, and a
  // repo rename can't silently break the round-trip the way a pinned string
  // did. Every value this can produce must be registered on Epic verbatim.
  // Resolves to the app root, so it holds whichever page launched the login.
  redirectUri: smartAppRoot(),

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

async function smartLaunch() {
  if (!SMART.clientId || SMART.clientId.indexOf("PASTE_") === 0) {
    throw new Error("Set SMART.clientId to your Epic non-production Client ID first.");
  }
  // file:// has no usable origin, so there is nothing Epic could redirect back
  // to. A localhost dev server is fine as long as its exact URL is registered.
  if (location.protocol === "file:") {
    throw new Error("Open the app over http(s) (npm run dev) — a file:// URL " +
      "cannot be an OAuth redirect target.");
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

  // Strip ?code=… from the address bar so a refresh doesn't re-run it. Uses the
  // live pathname rather than redirectUri: replaceState throws a SecurityError
  // on anything cross-origin, and this keeps the user on the page they're on.
  history.replaceState({}, "", location.pathname);
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
