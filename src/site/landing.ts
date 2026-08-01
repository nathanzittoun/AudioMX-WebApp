// Motion on the landing page — reference 1A's motion spec.
//
// Four things move, and each is saying something rather than decorating:
//
//   • the device settles once on load and its drop shadow deepens;
//   • the leader lines draw outward, staggered, so the eye follows them to the
//     part being named;
//   • the on-device timecode counts up and the screen trace redraws — the only
//     moving pixels above the fold, and what makes a still device read as a
//     recorder;
//   • spec cells, spectrum bars and the measurement panel reveal once when
//     reached. They do not loop: a measurement is not a visualiser.
//
// Two rules the previous version learned the hard way, both enforced here:
//
//   1. Nothing's *existence* depends on an animation callback. The class that
//      hides a revealable element is added by this file, never by the
//      stylesheet, so an element can only be hidden by code that has already
//      committed to showing it again. The revealed state is declared in CSS
//      rather than left to animation-fill-mode, so an animation that never runs
//      still leaves the content visible.
//   2. Reveals are driven from the animation loop, not from IntersectionObserver
//      or scroll events. Measured: in a page whose visibilityState is "hidden"
//      — a background tab, a headless browser — neither of those fires at all.
//
// The page used to stop itself whenever the application was on screen, because
// the two shared one document and a marketing animation has no business burning
// frames behind a clinical exam. They are separate pages now, so that gate is
// gone: nothing can be in front of this loop, and the browser already suspends
// requestAnimationFrame in a tab nobody is looking at.

import { el } from "../ui/dom";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where the on-device timecode lands, matching the number drawn on the screen. */
const TIMECODE_TARGET_SECONDS = 205;
const TIMECODE_MS = 2600;

/** Scroll depth past which the nav bar grows a hairline. */
const NAV_STICK_AT = 80;

let phase = 0;
let frame = 0;
let timecodeStartedAt = 0;

/** The miniature trace inside the device screen. */
function drawScreenWave(): void {
  const path = el<SVGPathElement>("lScreenWave");
  if (!path) return;
  const x0 = 72, y0 = 132, w = 98, h = 20;
  const parts: string[] = [];
  for (let i = 0; i <= 48; i++) {
    const x = i / 48;
    const envelope = Math.pow(Math.sin(Math.PI * x), 0.4);
    const v = Math.sin(x * 34 + phase * 2.1) * 0.6 + Math.sin(x * 79 - phase * 1.3) * 0.4;
    parts.push((i ? "L" : "M") + (x0 + x * w).toFixed(1) + " " +
      (y0 - v * envelope * h * 0.5).toFixed(1));
  }
  path.setAttribute("d", parts.join(" "));
}

/** Count the on-device timer up to the value printed on its screen. */
function drawTimecode(): void {
  const node = el("lTimecode");
  if (!node) return;
  const p = Math.min((performance.now() - timecodeStartedAt) / TIMECODE_MS, 1);
  const s = Math.floor(p * TIMECODE_TARGET_SECONDS);
  node.textContent = "00:" + String(Math.floor(s / 60)).padStart(2, "0") +
    ":" + String(s % 60).padStart(2, "0");
}

/**
 * Reveal anything marked [data-reveal] once it is on screen.
 *
 * One mechanism for the callouts, the spec cells, the bars and the measurement
 * panel, driven from the loop below. A rectangle test costs one layout read per
 * frame per pending element and nothing at all once they have all fired.
 */
function revealVisible(): void {
  const pending = document.querySelectorAll<HTMLElement>("#site [data-reveal]:not(.in)");
  if (pending.length === 0) return;
  const limit = window.innerHeight * 0.88;
  pending.forEach(node => {
    const box = node.getBoundingClientRect();
    if (box.top < limit && box.bottom > 0) node.classList.add("in");
  });
}

/** The nav bar takes a hairline once the hero has scrolled under it. */
function reflectNavBar(): void {
  const bar = el("lNavBar");
  if (bar) bar.classList.toggle("stuck", window.scrollY > NAV_STICK_AT);
}

function loop(): void {
  frame = 0;
  phase += 0.05;
  drawScreenWave();
  drawTimecode();
  revealVisible();
  reflectNavBar();
  frame = requestAnimationFrame(loop);
}

/** Start or restart the page. Safe to call every time it is shown. */
export function startLanding(): void {
  // One frame drawn synchronously, before any scheduling. requestAnimationFrame
  // does not run in a hidden page, so without this the device screen would show
  // an empty trace and a frozen 00:00:00 until the page is looked at.
  timecodeStartedAt = performance.now();
  drawScreenWave();
  if (REDUCED) {
    // The spec says the timecode freezes at its final value under reduced
    // motion rather than counting.
    const node = el("lTimecode");
    if (node) node.textContent = "00:03:25";
    revealVisible();
    return;
  }
  drawTimecode();
  if (!frame) frame = requestAnimationFrame(loop);
}

export function initLanding(): void {
  const readout = el("lReadout");
  const stage = document.querySelector<HTMLElement>(".lStage");

  // Mark what may be hidden, here rather than in the stylesheet.
  if (!REDUCED) {
    document.querySelectorAll<HTMLElement>(
      "#site .lCallout, #site .lSpec, #site .lBars, " +
      "#site .lMeasure, #site .lStep, #site .lInputCard"
    ).forEach(node => {
      node.dataset["reveal"] = "";
      node.classList.add("willReveal");
    });

    // The device rises once and its shadow deepens — 1A's "device settle", no
    // bounce. It is not revealable: the device is the page and must never be
    // hidden waiting for a frame.
    stage?.animate(
      [{ transform: "translateY(24px)" }, { transform: "none" }],
      { duration: 900, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" }
    );

    readout?.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: 600, delay: 1100, fill: "forwards" });
  } else if (readout) {
    readout.style.opacity = "1";
  }

  // Bars are drawn from their data attribute rather than 18 inline styles, so
  // the heights stay readable in the markup as one list of numbers.
  document.querySelectorAll<HTMLElement>("#site .lBars").forEach(host => {
    const heights = (host.dataset["bars"] ?? "").split(",").map(n => Number(n.trim()));
    for (const h of heights) {
      const bar = document.createElement("span");
      bar.style.setProperty("--h", h + "%");
      host.appendChild(bar);
    }
  });

  window.addEventListener("resize", drawScreenWave);
  startLanding();
}
