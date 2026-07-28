// Service worker registration — see public/sw.js for the caching strategy.
//
// Production only. In dev the worker would sit between Vite and the page and
// serve yesterday's modules back over hot reload, which looks exactly like an
// edit that did not take.

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;

  const base = import.meta.env.BASE_URL;
  const start = (): void => {
    navigator.serviceWorker
      .register(base + "sw.js", { scope: base })
      .catch((error: unknown) => {
        // Offline support is a bonus. It must never be able to break a page
        // that otherwise works — a clinician mid-exam does not care why.
        console.warn("Service worker registration failed:", error);
      });
  };

  // Deferred to "load" so registration never competes with the first paint or
  // with restoring recordings. The readyState test is "complete" for the same
  // reason boot() uses it in main.ts: by the time this runs the load event may
  // already have fired, and a listener added afterwards never runs.
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
