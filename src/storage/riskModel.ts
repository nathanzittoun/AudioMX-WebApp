// The seam Dr Rameau's model plugs into.
//
// The model is Python and cannot run in a browser, so scoring will always be a
// call to a backend. Defining the shape now means the clinical UI can render a
// "score" slot from day one, and switching from the placeholder to the real
// service is a one-line change of which implementation is installed — not a
// rewrite of the exam flow.

import type { VoiceFeatures } from "../core/features";

export interface ScoreInput {
  audio: Blob;
  sampleRate: number;
  channels: 1 | 2;
  /** Browser-computed features, when available. The model may ignore them. */
  features: VoiceFeatures | null;
  /** Which protocol task produced this take — models are task-specific. */
  testId: string;
  meta: { patientRef: string; sessionRef: string };
}

export interface RiskScore {
  label: string;
  value: number;
  unit?: string;
  /** Confidence interval, when the model reports one. */
  ci?: [number, number];
}

export interface RiskResult {
  modelId: string;
  modelVersion: string;
  computedAt: string;
  scores: RiskScore[];
  raw?: unknown;
}

export interface RiskModel {
  readonly id: string;
  readonly version: string;
  /** Checked before offering to score, so the UI can explain its absence. */
  isAvailable(): Promise<boolean>;
  score(input: ScoreInput): Promise<RiskResult>;
}

/**
 * Stands in until a backend exists. Reports unavailable rather than inventing
 * a number: a placeholder score displayed next to a real patient is a clinical
 * hazard, not a harmless stub.
 */
export const nullRiskModel: RiskModel = {
  id: "none",
  version: "0",
  async isAvailable() {
    return false;
  },
  async score() {
    throw new Error("No risk model is connected yet.");
  },
};

let active: RiskModel = nullRiskModel;

export function getRiskModel(): RiskModel {
  return active;
}

/** Swap in the HTTP-backed model once the scoring service is deployed. */
export function setRiskModel(model: RiskModel): void {
  active = model;
}
