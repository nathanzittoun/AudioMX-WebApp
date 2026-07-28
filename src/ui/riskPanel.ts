// The score slot on a take, drawn from the model that is actually installed.
//
// storage/riskModel.ts has defined this seam since the migration and nothing
// ever asked it anything: the chart printed the words "pending model" as a
// literal string. A literal is worse than no slot at all, because it keeps
// looking correct on the day a real model *is* connected — the UI would report
// "pending" over a service that had just returned an answer.
//
// So the slot asks getRiskModel(). Two states, and only two:
//
//   unavailable — say so plainly, show no number. A placeholder score next to
//                 a real patient is a clinical hazard, not a harmless stub.
//   available   — offer to score, and render what comes back. Scoring is not
//                 automatic on render: a chart holds many takes, and firing a
//                 backend call for each one on every repaint is not a decision
//                 this module gets to make silently.

import { SAMPLE_RATE } from "../core/constants";
import type { Recording } from "../core/state";
import { getRiskModel, type RiskResult } from "../storage/riskModel";

function head(text: string, badge: string, badgeClass: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "riskHead";
  const label = document.createElement("span");
  label.className = "riskLabel";
  label.textContent = text;
  const tag = document.createElement("span");
  tag.className = "riskBadge " + badgeClass;
  tag.textContent = badge;
  row.append(label, tag);
  return row;
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "riskNote";
  p.textContent = text;
  return p;
}

function renderResult(box: HTMLElement, result: RiskResult): void {
  box.replaceChildren(head("Risk model", result.modelId + " " + result.modelVersion, "ok"));

  const list = document.createElement("dl");
  list.className = "riskScores";
  for (const score of result.scores) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = score.label;
    const dd = document.createElement("dd");
    dd.textContent = score.value.toFixed(2) + (score.unit ? " " + score.unit : "") +
      (score.ci ? "  (" + score.ci[0].toFixed(2) + "–" + score.ci[1].toFixed(2) + ")" : "");
    row.append(dt, dd);
    list.appendChild(row);
  }
  box.appendChild(list);
  box.appendChild(note("Computed " + new Date(result.computedAt).toLocaleString() +
    ". A model output, not a diagnosis."));
}

/** The slot for one take. Returns immediately; the model is asked in the
 *  background, because isAvailable() will be a network call once a backend
 *  exists and the chart must not block on it. */
export function riskSlot(recording: Recording): HTMLElement {
  const box = document.createElement("div");
  box.className = "riskSlot";
  box.appendChild(head("Risk model", "checking", "pending"));

  const model = getRiskModel();

  void model.isAvailable().then(available => {
    if (!available) {
      box.replaceChildren(head("Risk model", "not connected", "pending"));
      box.appendChild(note(
        "No scoring service is connected, so this take has no score. The model " +
        "is Python and runs behind the backend; the acoustic features above are " +
        "measurements of the signal, not a result."));
      return;
    }

    box.replaceChildren(head("Risk model", model.id + " " + model.version, "ok"));
    const run = document.createElement("button");
    run.className = "smallBtn analyzeBtn";
    run.textContent = "Score this take";
    run.addEventListener("click", () => {
      run.disabled = true;
      run.textContent = "Scoring…";
      void model.score({
        audio: recording.blob,
        sampleRate: SAMPLE_RATE,
        channels: recording.channels === 2 ? 2 : 1,
        features: recording.features,
        testId: recording.meta?.testId ?? "",
        meta: {
          patientRef: recording.meta?.patientId ?? "",
          sessionRef: recording.meta?.sessionId ?? "",
        },
      }).then(result => {
        renderResult(box, result);
      }).catch((error: unknown) => {
        box.replaceChildren(head("Risk model", "failed", "no"));
        box.appendChild(note(error instanceof Error ? error.message : String(error)));
      });
    });
    box.appendChild(run);
  }).catch(() => {
    box.replaceChildren(head("Risk model", "unreachable", "no"));
    box.appendChild(note("The scoring service could not be reached."));
  });

  return box;
}
