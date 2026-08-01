// Entry point for the product site (index.html).
//
// Separate from the application in src/main.ts, and deliberately so: the two
// are different products with different audiences, and keeping them in one
// module graph meant every marketing change risked the clinical tool.
//
// This file is allowed to import from ui/ for the DOM helpers, and nothing
// else. If it ever needs the recorder, the transports or storage, the split
// has been broken.

import { initLanding } from "./landing";

/**
 * Hand an Epic OAuth callback to the application.
 *
 * The redirect URI registered with Epic is this directory, so the callback
 * always lands here even though the token exchange lives in the app. Rather
 * than re-register — a change that takes up to an hour to reach the sandbox and
 * would need every URL the app can be served from re-entered by hand — the site
 * forwards it.
 *
 * Three things make that safe, and all three are load-bearing:
 *
 *   • location.replace keeps the same tab, so the PKCE verifier and the state
 *     nonce that smart.ts left in sessionStorage are still there.
 *   • replace() rather than assign() keeps the callback URL — which carries a
 *     single-use authorization code — out of the history.
 *   • appRoot() strips the trailing filename, so from app.html it still
 *     computes this directory. The redirect_uri presented at token exchange is
 *     therefore the one Epic has on file.
 *
 * An error response is forwarded too. The app renders it; a blank product page
 * after a failed login tells the clinician nothing.
 */
function forwardEpicCallback(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return false;
  location.replace("app.html" + location.search);
  return true;
}

function boot(): void {
  if (forwardEpicCallback()) return;
  initLanding();
}

// Same reasoning as the application's entry: the bundle is injected in <head>,
// so evaluating at module scope runs before the body exists. "complete" rather
// than !== "loading", because a deferred module already sees "interactive".
if (document.readyState === "complete") {
  boot();
} else {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
}
