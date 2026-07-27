// Epic app registration settings.
//
// Split out from the client because this is the file that changes when the
// registration changes — a new Client ID, a different FHIR base, a move from
// the sandbox to a real organisation. Each value can also be overridden at
// build time through a VITE_ environment variable, so switching to a
// production registration does not require editing source.
//
// Note for the audience change: an Epic app's audience cannot be edited. Moving
// from a Patients app to a Clinicians one means registering a *new* app, which
// issues new Client IDs — so that is a value swap here, not a code change.

const env = import.meta.env;

export const SMART = {
  /**
   * Epic non-production Client ID. Public, not a secret — it travels in the
   * login URL. Swap for the production ID when leaving the sandbox.
   */
  clientId: env.VITE_SMART_CLIENT_ID ?? "05b94f6d-d653-4db8-abc2-5a750eea6df6",

  /** Epic's public R4 sandbox FHIR base (the "aud"/"iss"). */
  iss: env.VITE_SMART_ISS ?? "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",

  /**
   * What we ask permission to do. Must line up with the scopes registered on
   * Epic. Reading Patient + Observation is the proof of connection;
   * DocumentReference is the supported write path, because Epic rejects custom
   * Observations.
   */
  scope: env.VITE_SMART_SCOPE ??
    "openid fhirUser launch/patient patient/Patient.read patient/Observation.read " +
    "patient/DocumentReference.read patient/DocumentReference.write",
};

/**
 * The directory the app is served from, always ending in "/".
 *
 * Derived rather than pinned. Dropping the trailing filename means index.html,
 * patient.html and a bare directory URL all collapse to the same value, which
 * is what Epic has registered — and it means dev (localhost:5173) and prod
 * each hand Epic their own address without a config switch. A pinned string
 * silently broke the round trip when the repository was renamed.
 *
 * Every value this can produce must be registered on Epic verbatim.
 */
export function appRoot(): string {
  return location.origin + location.pathname.replace(/[^/]*$/, "");
}

/** The redirect URI handed to Epic. */
export function redirectUri(): string {
  return appRoot();
}
