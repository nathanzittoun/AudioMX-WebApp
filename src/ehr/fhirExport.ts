// HL7 FHIR R4 export.
//
// Maps a patient and their recorded voice takes into a standard FHIR R4
// transaction Bundle so the data can be ingested by a FHIR-capable EHR
// (e.g. Epic at Weill Cornell / NYP). This is a research-grade starting
// point, not a certified interface.
//
// Resource mapping (one Bundle per patient):
//   Patient            <- the patient record (id, name, gender, age)
//   Media              <- each WAV take (audio, inline base64, self-contained)
//   Observation x N    <- each acoustic feature of a take (F0, HNR, jitter,
//                         shimmer, formants) with UCUM units, derivedFrom Media
//   DiagnosticReport   <- ties one take's Observations + Media together
//
// The Bundle is a "transaction": every entry has a urn:uuid fullUrl and a
// POST request, so a FHIR server can accept the whole thing in one call and
// wire up the internal references itself.
//
// Patient and Observation are tagged with US Core R4 profiles (meta.profile)
// and carry the US-Core-required fields (typed MRN identifier, structured
// HumanName, category/value with UCUM), so a US-realm EHR like Epic will
// recognize them. The acoustic measure codes are still project-local pending
// alignment with the NIH Bridge2AI VBAI voice-biomarker IG.
//
// This is the file-download path. smart.ts writes to a live Epic instead, and
// deliberately does not reuse these resources: Epic rejects custom
// Observations, so that path files a DocumentReference.

import type { Recording } from "../core/state";
import type { StoredPatient } from "../storage/types";
import { library } from "../core/state";
import { sanitizeForFilename, triggerDownload } from "../ui/download";

// Local code system for the acoustic measures. There are no standard LOINC
// codes for jitter/shimmer/HNR/F0 today, so we bind them to a project system
// and carry a human-readable display. The natural target to align these with
// is the NIH Bridge2AI "Voice as a Biomarker for AI" (VBAI) FHIR IG
// (kind-lab/voice-biomarker-fhir), the emerging community standard.
const FHIR_ACOUSTIC_SYSTEM = "http://audiomx.org/fhir/CodeSystem/acoustic-voice";
const FHIR_PATIENT_SYSTEM = "http://audiomx.org/fhir/identifier/patient";

// US Core R4 profile canonicals. Tagging resources with meta.profile is what
// lets a US-realm EHR (e.g. Epic) recognize and validate them as US Core.
const US_CORE = "http://hl7.org/fhir/us/core/StructureDefinition/";
const US_CORE_PATIENT = US_CORE + "us-core-patient";
const US_CORE_OBSERVATION = US_CORE + "us-core-observation-clinical-result";

/**
 * The acoustic measures that become Observations.
 *
 * `key` is constrained to the voiced half of VoiceFeatures rather than typed
 * as a loose string: a renamed feature then fails the typecheck here instead
 * of silently dropping a measurement out of every export.
 */
type AcousticKey = "f0" | "hnrDb" | "jitterPct" | "shimmerPct" | "f1" | "f2";

interface AcousticFeature {
  key: AcousticKey;
  code: string;
  display: string;
  unit: string;
  /** UCUM code for valueQuantity.code, which is what a server validates. */
  ucum: string;
  digits: number;
}

const FHIR_FEATURES: readonly AcousticFeature[] = [
  { key: "f0", code: "F0", display: "Fundamental frequency (mean)", unit: "Hz", ucum: "Hz", digits: 1 },
  { key: "hnrDb", code: "HNR", display: "Harmonics-to-noise ratio", unit: "dB", ucum: "dB", digits: 1 },
  { key: "jitterPct", code: "JITTER", display: "Jitter (local)", unit: "%", ucum: "%", digits: 3 },
  { key: "shimmerPct", code: "SHIMMER", display: "Shimmer (local)", unit: "%", ucum: "%", digits: 2 },
  { key: "f1", code: "F1", display: "First formant", unit: "Hz", ucum: "Hz", digits: 0 },
  { key: "f2", code: "F2", display: "Second formant", unit: "Hz", ucum: "Hz", digits: 0 },
];

// ---- FHIR shapes ---------------------------------------------------------
//
// Narrow on purpose: only the fields this exporter writes. A full R4 type set
// would be thousands of lines and would not catch anything more here.

interface Narrative {
  status: "generated";
  div: string;
}

interface Coding {
  system: string;
  code: string;
  display?: string;
}

interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

interface HumanName {
  text: string;
  family?: string;
  given?: string[];
}

interface Quantity {
  value: number | string;
  unit: string;
  system?: string;
  code?: string;
}

interface FhirResource {
  resourceType: string;
  text?: Narrative;
  [key: string]: unknown;
}

interface BundleEntry {
  fullUrl: string;
  resource: FhirResource;
  request: { method: "POST"; url: string };
}

export interface FhirBundle {
  resourceType: "Bundle";
  type: "transaction";
  entry: BundleEntry[];
}

// ---- helpers -------------------------------------------------------------

/** Fallback counter for browsers without crypto.randomUUID. */
let uuidCounter = 0;

function fhirUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return "urn:uuid:" + crypto.randomUUID();
  }
  // Older browsers: timestamp + counter, still unique within a run.
  uuidCounter += 1;
  return "urn:uuid:audiomx-" + Date.now() + "-" + uuidCounter;
}

export function fhirGender(sex: string | undefined): string {
  const s = (sex || "").trim().toLowerCase();
  if (s === "m" || s === "male") return "male";
  if (s === "f" || s === "female") return "female";
  if (s === "other" || s === "o") return "other";
  return "unknown";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked: spreading a whole multi-megabyte take into fromCharCode blows
  // the argument limit and throws a RangeError.
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Escape text for embedding in the XHTML narrative <div>. */
function fhirEscape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A generated human-readable narrative. FHIR best practice (constraint dom-6)
 * is that every DomainResource carries one.
 */
function fhirNarrative(text: string): Narrative {
  return {
    status: "generated",
    div: '<div xmlns="http://www.w3.org/1999/xhtml">' + fhirEscape(text) + "</div>",
  };
}

/**
 * US Core requires a HumanName with at least family or given — a plain text
 * name is not enough. Split "Jean Doe" into given ["Jean"], family "Doe".
 */
function fhirHumanName(patient: StoredPatient): HumanName[] {
  const raw = String(patient.name || "").trim();
  const label = raw || patient.id; // de-identified patients may have no name
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [{ text: label, family: label }];
  return [{ text: label, family: parts[parts.length - 1], given: parts.slice(0, -1) }];
}

// ---- resources -----------------------------------------------------------

function fhirPatientResource(patient: StoredPatient): FhirResource {
  const res: FhirResource = {
    resourceType: "Patient",
    meta: { profile: [US_CORE_PATIENT] },
    text: fhirNarrative("Patient " + patient.id +
      (patient.name ? " (" + patient.name + ")" : "") + " · " + fhirGender(patient.sex) +
      (patient.age ? " · " + patient.age + " y" : "")),
    // US Core wants an identifier typed as a Medical Record Number (MR).
    identifier: [{
      type: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical Record Number" }],
        text: "Medical Record Number",
      } satisfies CodeableConcept,
      system: FHIR_PATIENT_SYSTEM,
      value: patient.id,
    }],
    name: fhirHumanName(patient),
    gender: fhirGender(patient.sex),
  };

  // Age (no DOB is collected) is carried as an extension, in years.
  if (patient.age) {
    res["extension"] = [{
      url: "http://audiomx.org/fhir/StructureDefinition/patient-age-years",
      valueQuantity: {
        value: Number(patient.age) || patient.age,
        unit: "years",
        system: "http://unitsofmeasure.org",
        code: "a",
      } satisfies Quantity,
    }];
  }
  return res;
}

function fhirObservationResource(
  feature: AcousticFeature,
  value: number,
  patientRef: string,
  mediaRef: string,
  when: string,
  testName: string
): FhirResource {
  const rounded = Number(value.toFixed(feature.digits));
  return {
    resourceType: "Observation",
    meta: { profile: [US_CORE_OBSERVATION] },
    text: fhirNarrative(feature.display + ": " + rounded + " " + feature.unit +
      " (" + (testName || "voice task") + ")"),
    status: "final",
    category: [{
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "exam", display: "Exam" }],
    } satisfies CodeableConcept],
    code: {
      coding: [{ system: FHIR_ACOUSTIC_SYSTEM, code: feature.code, display: feature.display }],
      text: feature.display,
    } satisfies CodeableConcept,
    subject: { reference: patientRef },
    effectiveDateTime: when,
    valueQuantity: {
      value: rounded,
      unit: feature.unit,
      system: "http://unitsofmeasure.org",
      code: feature.ucum,
    } satisfies Quantity,
    derivedFrom: [{ reference: mediaRef }],
    method: { text: "AudioMX in-browser acoustic analysis (" + (testName || "voice task") + ")" },
  };
}

async function fhirMediaResource(
  recording: Recording,
  patientRef: string,
  when: string,
  testName: string
): Promise<FhirResource> {
  return {
    resourceType: "Media",
    text: fhirNarrative("Audio recording (" + (testName || "voice task") + ") · " +
      recording.duration.toFixed(2) + " s · audio/wav"),
    status: "completed",
    type: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/media-type", code: "audio", display: "Audio" }],
    } satisfies CodeableConcept,
    subject: { reference: patientRef },
    createdDateTime: when,
    duration: Number(recording.duration.toFixed(3)),
    content: {
      contentType: "audio/wav",
      data: await blobToBase64(recording.blob),
      title: (recording.name || testName || "voice take") + ".wav",
    },
  };
}

// ---- the bundle ----------------------------------------------------------

/** Build a FHIR R4 transaction Bundle for one patient's recordings. */
export async function buildFhirBundle(
  patient: StoredPatient,
  recordings: Recording[]
): Promise<FhirBundle> {
  const entries: BundleEntry[] = [];
  const patientRef = fhirUuid();

  entries.push({
    fullUrl: patientRef,
    resource: fhirPatientResource(patient),
    request: { method: "POST", url: "Patient" },
  });

  for (const r of recordings) {
    // Takes restored from IndexedDB carry a string, not a Date.
    const when = (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString();
    const testName = r.meta?.testName ?? "";

    const mediaRef = fhirUuid();
    entries.push({
      fullUrl: mediaRef,
      resource: await fhirMediaResource(r, patientRef, when, testName),
      request: { method: "POST", url: "Media" },
    });

    const obsRefs: string[] = [];
    const f = r.features;
    if (f && f.voiced) {
      for (const feature of FHIR_FEATURES) {
        const v = f[feature.key];
        // Skips both an absent formant (null) and a NaN from a failed
        // estimate: FHIR has no way to say "measured, value unusable".
        if (v == null || !isFinite(v)) continue;
        const obsRef = fhirUuid();
        obsRefs.push(obsRef);
        entries.push({
          fullUrl: obsRef,
          resource: fhirObservationResource(feature, v, patientRef, mediaRef, when, testName),
          request: { method: "POST", url: "Observation" },
        });
      }
    }

    // FHIR rule: arrays/objects are never empty and properties are never
    // null — an empty element must be omitted entirely. So we only attach
    // result/conclusion when they actually have content.
    const report: FhirResource = {
      resourceType: "DiagnosticReport",
      text: fhirNarrative("Voice acoustic analysis — " + (testName || "voice task") +
        " · " + obsRefs.length + " measurement(s)"),
      status: "final",
      category: [{
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "OTH", display: "Other" }],
      } satisfies CodeableConcept],
      code: {
        coding: [{ system: FHIR_ACOUSTIC_SYSTEM, code: "VOICE-ACOUSTIC", display: "Voice acoustic analysis" }],
        text: "Voice acoustic analysis — " + (testName || "voice task"),
      } satisfies CodeableConcept,
      subject: { reference: patientRef },
      effectiveDateTime: when,
      media: [{ link: { reference: mediaRef } }],
    };
    if (obsRefs.length) report["result"] = obsRefs.map(ref => ({ reference: ref }));
    if (r.meta?.notes) report["conclusion"] = r.meta.notes;

    entries.push({
      fullUrl: fhirUuid(),
      resource: report,
      request: { method: "POST", url: "DiagnosticReport" },
    });
  }

  return { resourceType: "Bundle", type: "transaction", entry: entries };
}

// ---- the download --------------------------------------------------------

export async function downloadPatientFhir(): Promise<void> {
  if (!currentPatient) { alert("Open a patient first."); return; }
  const patient = currentPatient;

  const items = library.recordings.filter(r => r.meta?.patientId === patient.id);
  if (items.length === 0) { alert("No recordings for this patient."); return; }

  log("Building FHIR R4 bundle for " + patient.id + "…");
  const bundle = await buildFhirBundle(patient, items);
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: "application/fhir+json" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, "AudioMX_FHIR_" + sanitizeForFilename(patient.id) + ".json");
  URL.revokeObjectURL(url);

  const obs = bundle.entry.filter(e => e.resource.resourceType === "Observation").length;
  log("FHIR bundle exported: " + items.length + " Media + " + obs + " Observation resource(s).");
}
