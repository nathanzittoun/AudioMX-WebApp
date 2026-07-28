// The connection pill in the header: one line of text and a coloured dot.
//
// A leaf, for the same reason as ui/log: the three transports each report
// their own state, and a USB driver has no business importing the application
// shell to do it.

/** What the dot conveys at a glance. */
export type StatusKind = "idle" | "connected" | "recording";

/** Connection state, written to every place that displays it.
 *
 *  It used to be written to two fixed ids. The overview page shows the same
 *  state a second time, and a second hard-coded pair would be two things to
 *  keep in step; marking the nodes instead means a third display costs an
 *  attribute and no code. Behaviour for the header pill is unchanged — it now
 *  carries the attributes. */
export function setStatus(message: string, state: StatusKind = "idle"): void {
  document.querySelectorAll<HTMLElement>("[data-status-text]").forEach(node => {
    node.textContent = message;
  });
  document.querySelectorAll<HTMLElement>("[data-status-dot]").forEach(node => {
    node.className = state === "idle" ? "statusDot" : "statusDot " + state;
  });
}
