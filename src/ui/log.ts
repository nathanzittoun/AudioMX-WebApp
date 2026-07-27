// The activity log strip at the bottom of the R&D view.
//
// Its own module, and a leaf on purpose. Ten modules across every layer write
// to it — the DSP, the transports, storage, the EHR client — and none of them
// should have to import the application shell to say a sentence. It reaches
// only for the log element, so nothing can import a cycle through it.

import { el } from "./dom";

/** Append one timestamped line. Silent on a page without the log element. */
export function log(message: string): void {
  const container = el("log");
  if (!container) return;
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.textContent = "[" + time + "] " + message;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}
