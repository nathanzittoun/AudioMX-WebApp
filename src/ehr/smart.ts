// SMART on FHIR client — standalone launch, public client + PKCE.
//
// The login layer that lets AudioMX connect to a real FHIR server (Epic's
// sandbox today), authenticate, and read or write a patient's chart. Entirely
// in the browser: PKCE makes the OAuth handshake safe without a backend or a
// client secret, which is what a static site can do.
//
// Flow:
//   1. launch()          discover Epic's endpoints, build a PKCE challenge,
//                        redirect to the Epic login.
//   2. (the user logs in on Epic, picks a patient, approves scopes)
//   3. Epic redirects back with ?code=… and handleRedirect() exchanges it for
//      an access token, proving possession of the PKCE verifier.
//   4. fetchFhir() and friends call the API with that token.
//
// SECURITY: a sandbox/research starting point. Real PHI needs the Phase 4
// items — backend token handling, audit logging, a signed BAA. The token lives
// in memory here, which is deliberate: sessionStorage would survive a tab
// reload and widen the exposure for no benefit at this stage.

import { SMART, redirectUri } from "./config";

interface SmartSession {
  accessToken: string;
  patient: string | null;
  tokenType: string;
  fhirBase: string;
}

interface SmartConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
}

let session: SmartSession | null = null;

const base = (): string => SMART.iss.replace(/\/+$/, "");

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafe(len: number): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return b64url(a);
}

/** PKCE verifier + S256 challenge pair. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomUrlSafe(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

/** Read the server's SMART configuration to find its authorize/token URLs. */
async function discover(): Promise<SmartConfiguration> {
  const res = await fetch(base() + "/.well-known/smart-configuration", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("SMART discovery failed (" + res.status + ")");
  return res.json() as Promise<SmartConfiguration>;
}

export function isConnected(): boolean {
  return !!session?.accessToken;
}

export function currentPatientId(): string | null {
  return session?.patient ?? null;
}

// ---- step 1: start the login -------------------------------------------

export async function launch(): Promise<void> {
  if (!SMART.clientId || SMART.clientId.startsWith("PASTE_")) {
    throw new Error("Set the Epic non-production Client ID in src/ehr/config.ts first.");
  }
  // file:// has no usable origin, so there is nothing Epic could redirect back
  // to. A localhost dev server is fine as long as its exact URL is registered.
  if (location.protocol === "file:") {
    throw new Error("Open the app over http(s) (npm run dev). A file:// URL cannot be an OAuth redirect target.");
  }

  const cfg = await discover();
  const { verifier, challenge } = await pkce();
  const state = randomUrlSafe(16);
  const uri = redirectUri();

  // Survives the full-page redirect to Epic and back, which is the whole point
  // of PKCE: the verifier never leaves this browser.
  sessionStorage.setItem("smart_verifier", verifier);
  sessionStorage.setItem("smart_state", state);
  sessionStorage.setItem("smart_token_endpoint", cfg.token_endpoint);

  const q = new URLSearchParams({
    response_type: "code",
    client_id: SMART.clientId,
    redirect_uri: uri,
    scope: SMART.scope,
    state,
    aud: SMART.iss,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const authUrl = cfg.authorization_endpoint + "?" + q.toString();
  // Logged because a redirect_uri mismatch is the single most common failure,
  // and Epic reports it only as an opaque "request is invalid" after login.
  console.log("[SMART] redirect_uri =", uri, "\n[SMART] authorize =", authUrl);
  location.assign(authUrl);
}

// ---- step 3: handle the redirect back ----------------------------------

/** True when this page load completed a login. */
export async function handleRedirect(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;

  if (params.get("error")) {
    throw new Error("Epic returned an error: " + params.get("error") +
      ": " + (params.get("error_description") || ""));
  }
  if (params.get("state") !== sessionStorage.getItem("smart_state")) {
    throw new Error("State mismatch (possible CSRF). Aborting.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: SMART.clientId,
    code_verifier: sessionStorage.getItem("smart_verifier") ?? "",
  });

  const res = await fetch(sessionStorage.getItem("smart_token_endpoint") ?? "", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  const tok = await res.json();
  if (!res.ok || !tok.access_token) {
    throw new Error("Token exchange failed: " + (tok.error_description || tok.error || res.status));
  }

  session = {
    accessToken: tok.access_token,
    patient: tok.patient || null,
    tokenType: tok.token_type || "Bearer",
    fhirBase: SMART.iss,
  };

  // Strip ?code=… so a refresh does not replay it. Uses the live pathname
  // rather than the redirect URI: replaceState throws a SecurityError on
  // anything cross-origin.
  history.replaceState({}, "", location.pathname);
  return true;
}

// ---- step 4: call the FHIR API -----------------------------------------

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}

export async function fetchFhir<T = unknown>(path: string, opts: FetchOptions = {}): Promise<T> {
  if (!session) throw new Error("Not connected to a FHIR server.");

  const res = await fetch(base() + "/" + path.replace(/^\/+/, ""), {
    method: opts.method ?? "GET",
    headers: {
      Authorization: session.tokenType + " " + session.accessToken,
      Accept: "application/fhir+json",
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error("FHIR " + res.status + ": " +
      (json.issue?.[0]?.diagnostics || text));
  }
  return json as T;
}

/** Load the patient chosen during launch. */
export async function loadPatient<T = unknown>(): Promise<T> {
  if (!session?.patient) throw new Error("No patient in launch context.");
  return fetchFhir<T>("Patient/" + session.patient);
}

/**
 * List the patient's Observations. Epic rejects a bare patient search with
 * "Must have either code or category", so each category is tried in turn.
 */
export async function listObservations(): Promise<{ entry?: unknown[]; total?: number }> {
  for (const category of ["laboratory", "vital-signs"]) {
    const bundle = await fetchFhir<{ entry?: unknown[] }>(
      "Observation?patient=" + encodeURIComponent(session?.patient ?? "") +
      "&category=" + category + "&_count=20"
    );
    if (bundle.entry?.length) return bundle;
  }
  return { total: 0, entry: [] };
}

/**
 * Write a voice-analysis note as a DocumentReference — the path Epic actually
 * supports for novel data. Custom Observations are rejected with a 403; only
 * recognised Vital Signs are writable, and a voice biomarker is neither.
 */
export async function writeDocumentReference(text: string): Promise<unknown> {
  const doc = {
    resourceType: "DocumentReference",
    status: "current",
    docStatus: "final",
    type: {
      coding: [{ system: "http://loinc.org", code: "34117-2", display: "History and physical note" }],
      text: "AudioMX voice acoustic analysis",
    },
    subject: { reference: "Patient/" + (session?.patient ?? "") },
    content: [{
      attachment: {
        contentType: "text/plain",
        data: btoa(unescape(encodeURIComponent(text))),
        title: "AudioMX voice acoustic analysis",
      },
    }],
  };

  return fetchFhir("DocumentReference", {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(doc),
  });
}
