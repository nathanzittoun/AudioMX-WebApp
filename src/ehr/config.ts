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
   * Epic Client ID for "AudioMX Clinician". Public, not a secret — it travels
   * in the login URL.
   *
   * This is the **Non-Production** ID, which is the one the sandbox `iss`
   * below accepts. The production ID for the same app is
   * 0c78ad31-e03e-424d-89e2-fca2af500835; it only starts working after go-live
   * with a real organisation, so pointing at it now would fail with an opaque
   * error rather than anything useful.
   *
   * Replaces the earlier "AudioMX Patient" registration
   * (05b94f6d-d653-4db8-abc2-5a750eea6df6). An Epic app's audience cannot be
   * edited, so moving from Patients to Clinicians meant a second registration.
   */
  clientId: env.VITE_SMART_CLIENT_ID ?? "09a25bf9-07e2-4e13-b27d-486d885d5bde",

  /** Epic's public R4 sandbox FHIR base (the "aud"/"iss"). */
  iss: env.VITE_SMART_ISS ?? "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",

  /**
   * What we ask permission to do. Must line up with the APIs registered on
   * Epic, which are the real gate — asking for something unregistered gets it
   * denied, and registering something we never ask for is dead weight.
   *
   * `user/` rather than `patient/`: a Clinicians-audience app acts as the
   * logged-in clinician across the patients they may see, where a
   * Patients-audience app was scoped to the one person logging in.
   *
   * `launch/patient` asks Epic to establish patient context. In an EHR launch
   * from Hyperspace that context comes from the chart already open. In the
   * standalone launch this app uses, Epic is expected to prompt for patient
   * selection — that is the part to confirm against the sandbox, because
   * without a patient in the token, loadPatient() has nothing to fetch.
   */
  scope: env.VITE_SMART_SCOPE ??
    "openid fhirUser launch/patient user/Patient.read user/Observation.read " +
    "user/DocumentReference.read user/DocumentReference.write",
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
