// Entry point for the product site (index.html).
//
// Separate from the application in src/main.ts, and deliberately so: the two
// are different products with different audiences, and keeping them in one
// module graph meant every marketing change risked the clinical tool.
//
// This file may import ui/dom for the element helpers and nothing else. If it
// ever needs the recorder, a transport or storage, the split has been broken —
// there is a smoke assertion that fails when window.audiomx appears here.

import { initFilmSection } from "./filmSection";
import { initHeroSequence } from "./heroSequence";
import { initScrollDevice } from "./scrollDevice";
import { el } from "../ui/dom";

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

/** The product bar gains a hairline once the hero has scrolled under it. */
function initStickyBar(): void {
  const bar = document.querySelector<HTMLElement>(".product-nav");
  if (!bar) return;
  const reflect = () => bar.classList.toggle("is-stuck", window.scrollY > 8);
  reflect();
  window.addEventListener("scroll", reflect, { passive: true });
}

/** The small-screen menu. */
function initMenu(): void {
  const button = document.querySelector<HTMLButtonElement>(".menu-button");
  const menu = el("global-menu");
  if (!button || !menu) return;
  button.addEventListener("click", () => {
    const open = menu.classList.toggle("is-open");
    button.setAttribute("aria-expanded", String(open));
  });
  // A link that scrolls the page behind an open menu leaves the visitor
  // looking at the menu, wondering whether the tap registered.
  menu.addEventListener("click", event => {
    if (!(event.target as Element).closest("a")) return;
    menu.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  });
}

/** Arrows for the highlights strip, which is a horizontal scroller. */
function initGallery(): void {
  const strip = document.querySelector<HTMLElement>(".highlights-gallery");
  if (!strip) return;
  document.querySelectorAll<HTMLButtonElement>(".gallery-controls button").forEach(button => {
    button.addEventListener("click", () => {
      const direction = button.dataset["dir"] === "prev" ? -1 : 1;
      strip.scrollBy({
        left: direction * Math.min(window.innerWidth * 0.72, 760),
        behavior: "smooth",
      });
    });
  });
}

/**
 * Reveal sections as they are reached.
 *
 * Driven from a scroll listener with a rectangle test rather than an
 * IntersectionObserver. Measured, and the reason an earlier version of this
 * page shipped broken: in a document whose visibilityState is "hidden" — a
 * background tab, a headless browser — IntersectionObserver never fires at all,
 * so content that depended on it stayed invisible forever with no error.
 *
 * The hidden state is added here rather than declared in the stylesheet, so
 * nothing can be hidden except by code that has already committed to showing it
 * again. Under reduced motion nothing is ever hidden in the first place.
 */
function initReveals(): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const pending = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
  pending.forEach(node => node.classList.add("will-reveal"));

  let queued = 0;
  const check = (): void => {
    queued = 0;
    const limit = window.innerHeight * 0.9;
    for (let i = pending.length - 1; i >= 0; i--) {
      const node = pending[i]!;
      const box = node.getBoundingClientRect();
      if (box.top < limit && box.bottom > 0) {
        node.classList.add("is-revealed");
        pending.splice(i, 1);
      }
    }
    if (pending.length === 0) window.removeEventListener("scroll", schedule);
  };
  const schedule = (): void => {
    if (queued) return;
    queued = requestAnimationFrame(check);
  };

  check();
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  // The first check runs before the images have loaded, so the layout it
  // measures is not the final one. On a short viewport a section that ends up
  // on screen can be measured as below it, and with nothing left to scroll it
  // would stay hidden for good. Re-check once everything has settled.
  window.addEventListener("load", check, { once: true });
}

function boot(): void {
  if (forwardEpicCallback()) return;
  initStickyBar();
  initMenu();
  initGallery();
  initReveals();
  initHeroSequence();
  initScrollDevice();
  initFilmSection();
}

// Same reasoning as the application's entry: the bundle is injected in <head>,
// so evaluating at module scope runs before the body exists. "complete" rather
// than !== "loading", because a deferred module already sees "interactive".
if (document.readyState === "complete") {
  boot();
} else {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
}
