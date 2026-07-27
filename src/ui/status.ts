// The connection pill in the header: one line of text and a coloured dot.
//
// A leaf, for the same reason as ui/log: the three transports each report
// their own state, and a USB driver has no business importing the application
// shell to do it.

import { el } from "./dom";

/** What the dot conveys at a glance. */
export type StatusKind = "idle" | "connected" | "recording";

export function setStatus(message: string, state: StatusKind = "idle"): void {
  const status = el("status");
  const dot = el("statusDot");
  if (status) status.textContent = message;
  if (!dot) return;
  dot.className = "statusDot";
  if (state === "connected") dot.classList.add("connected");
  if (state === "recording") dot.classList.add("recording");
}
