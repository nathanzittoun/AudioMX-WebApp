// Tab switching for the R&D views.
//
// Lives in its own module because audio.js calls showTab() when you analyse a
// take, so it has to be reachable from the legacy world too — bridge.ts
// publishes it. Once audio.js is converted, that publication goes away and this
// becomes an ordinary import.

export function showTab(tabId: string): void {
  document.querySelectorAll(".view").forEach(view => {
    view.classList.remove("activeView");
  });

  document.getElementById(tabId)?.classList.add("activeView");

  document.querySelectorAll<HTMLElement>(".tabBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["tab"] === tabId);
  });

  // The spectrum background is sized from the current zoom range, so it has to
  // be redrawn whenever the analyse view becomes visible.
  if (tabId === "analyzeView") {
    drawSpectrumBackground(
      Number(fftMinFreqInput.value) || 0,
      Number(fftMaxFreqInput.value) || SAMPLE_RATE / 2
    );
  }
}
