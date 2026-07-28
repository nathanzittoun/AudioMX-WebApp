// Tab switching for the R&D views.
//
// Lives in its own module because audio.js calls showTab() when you analyse a
// take, so it has to be reachable from the legacy world too — bridge.ts
// publishes it. Once audio.js is converted, that publication goes away and this
// becomes an ordinary import.

import { SAMPLE_RATE } from "../core/constants";
import { drawSpectrumBackground } from "../rnd/fftView";
import { el } from "./dom";
import { reflectNav } from "./nav";

export function showTab(tabId: string): void {
  document.querySelectorAll(".view").forEach(view => {
    view.classList.remove("activeView");
  });

  document.getElementById(tabId)?.classList.add("activeView");

  // The single nav bar replaced the per-mode tab bars; it reads the DOM, so it
  // follows a showTab() called from a recording card just as well as a click.
  reflectNav();

  // The spectrum background is sized from the current zoom range, so it has to
  // be redrawn whenever the analyse view becomes visible.
  if (tabId === "analyzeView") {
    drawSpectrumBackground(
      Number(el<HTMLInputElement>("fftMinFreqInput")?.value) || 0,
      Number(el<HTMLInputElement>("fftMaxFreqInput")?.value) || SAMPLE_RATE / 2
    );
  }
}
