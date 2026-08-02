// Voice-task protocol for the Clinical section, based on the AudioMX protocol
// (MPT, DDK/ODT, CAPE-V, Rainbow Passage) plus cough and spontaneous speech.
// Patient instructions are kept at roughly a Grade-4 reading level.
//
// Shared by both windows: the clinician view drives the exam from it, and the
// patient pop-out renders patientTitle/patientSteps/reads from the same source.

/**
 * What the clinician window sends to the patient window.
 *
 * The two windows share exactly two things: this contract and the test
 * definitions below. It lives here because both sides must agree on it and
 * neither may import the other — the patient pop-out is its own entry point
 * and must stay loadable on its own.
 */
export type PatientMessage =
  | { kind: "test"; testId: string }
  | { kind: "go"; on: boolean }
  | { kind: "countdown"; seconds: number }
  | { kind: "timerStart"; seconds: number | null }
  | { kind: "timerStop" }
  | { kind: "ready" };

export interface ProtocolTest {
  id: string;
  name: string;
  icon: string;
  /** Shown large on the patient screen. */
  patientTitle: string;
  /** Numbered instructions on the patient screen. */
  patientSteps: string[];
  /** Text the patient reads aloud, or null when the task is not a reading. */
  reads: string[] | null;
  /** Timer length in seconds, or null when the task runs until stopped. */
  holdSeconds: number | null;
  /** Clinician-facing rationale — never shown to the patient. */
  clinicianNote: string;
}

const CAPEV_SENTENCES = [
  "The blue spot is on the key again.",
  "How hard did he hit him?",
  "We were away a year ago.",
  "We eat eggs every Easter.",
  "My mama makes lemon muffins.",
  "Peter will keep at the peak."
];

const RAINBOW_PASSAGE =
  "When the sunlight strikes raindrops in the air, they act as a prism and " +
  "form a rainbow. The rainbow is a division of white light into many " +
  "beautiful colors. These take the shape of a long round arch, with its " +
  "path high above, and its two ends apparently beyond the horizon.";

export const PROTOCOL_TESTS: ProtocolTest[] = [
  {
    id: "mpt",
    name: "Sustained Vowel (MPT)",
    icon: "🫁",
    patientTitle: "Say “Ahhh” for as long as you can",
    patientSteps: [
      "Take a deep breath in.",
      "Say “ahhh” in one long, steady breath.",
      "Keep going until you run out of air."
    ],
    reads: null,
    holdSeconds: 15,
    clinicianNote: "Maximum phonation time: vocal-fold closure and respiratory support."
  },
  {
    id: "ddk",
    name: "Pa-Ta-Ka (DDK)",
    icon: "👄",
    patientTitle: "Say “pa-ta-ka” over and over",
    patientSteps: [
      "Say “pa-ta-ka, pa-ta-ka, pa-ta-ka”.",
      "Go as fast and as clearly as you can.",
      "Keep repeating until we say stop."
    ],
    reads: null,
    holdSeconds: 8,
    clinicianNote: "Oral diadochokinetic rate: oral coordination, relevant to dysphagia."
  },
  {
    id: "capev",
    name: "CAPE-V Sentences",
    icon: "🗣️",
    patientTitle: "Read these sentences out loud",
    patientSteps: [
      "Read each line in your normal voice.",
      "Take your time. One line at a time."
    ],
    reads: CAPEV_SENTENCES,
    holdSeconds: null,
    clinicianNote: "CAPE-V: roughness, breathiness, strain, pitch, loudness."
  },
  {
    id: "rainbow",
    name: "Rainbow Passage",
    icon: "🌈",
    patientTitle: "Read this out loud",
    patientSteps: [
      "Read the paragraph in your normal speaking voice.",
      "Read at a comfortable pace."
    ],
    reads: [RAINBOW_PASSAGE],
    holdSeconds: null,
    clinicianNote: "Connected speech: resonance, fluency, articulation, prosody."
  },
  {
    id: "cough",
    name: "Voluntary Cough",
    icon: "💨",
    patientTitle: "Give one strong cough",
    patientSteps: [
      "Take a breath.",
      "Give one strong, clear cough."
    ],
    reads: null,
    holdSeconds: 3,
    clinicianNote: "Cough strength: airway protection and pulmonary cue."
  },
  {
    id: "spontaneous",
    name: "Spontaneous Speech",
    icon: "💬",
    patientTitle: "Tell us about your morning",
    patientSteps: [
      "Talk about what you did this morning.",
      "Keep talking in your normal voice for about 30 seconds."
    ],
    reads: null,
    holdSeconds: 30,
    clinicianNote: "Free speech: natural prosody and articulation."
  }
];

export function getProtocolTest(id: string): ProtocolTest | null {
  return PROTOCOL_TESTS.find(t => t.id === id) ?? null;
}
