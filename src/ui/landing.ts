// Motion on the landing page.
//
// Three things move, and each one is saying something rather than decorating:
//
//   • the full-width waveform runs continuously and gains amplitude as you
//     scroll, so the page behaves like the instrument it is selling;
//   • the device screen wakes and its timecode counts up to the value printed
//     on the render, which is what makes a still image read as a recorder;
//   • the internals rise into view once, when you reach them.
//
// prefers-reduced-motion is honoured by drawing one static frame and stopping.
// Everything is cancelled while the landing page is not on screen: the app is a
// clinical tool and a marketing animation has no business burning a frame
// budget behind an exam.

import { el } from "./dom";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Sample count along the waveform. 260 keeps the path under 4 kB of `d`. */
const POINTS = 260;
const WAVE_HEIGHT = 64;

/** Resting amplitude, and how far a scroll can push it. */
const REST_ENERGY = 0.35;
const MAX_ENERGY = 1;

let phase = 0;
let energy = REST_ENERGY;
let lastScrollY = 0;
let frame = 0;

function waveGeometry(width: number, height: number, amplitude: number): string {
  const mid = height / 2;
  const parts: string[] = [];
  for (let i = 0; i <= POINTS; i++) {
    const x = i / POINTS;
    // Fades to nothing at both ends so the line does not appear to be cut off
    // by the viewport.
    const envelope = Math.pow(Math.sin(Math.PI * x), 0.7);
    const v =
      Math.sin(x * 46 + phase) * 0.55 +
      Math.sin(x * 17 - phase * 1.7) * 0.3 +
      Math.sin(x * 103 + phase * 0.6) * 0.15;
    const y = mid + v * envelope * amplitude * mid * 1.7;
    parts.push((i ? "L" : "M") + (x * width).toFixed(1) + " " + y.toFixed(1));
  }
  return parts.join(" ");
}

function drawWave(): void {
  const svg = el<SVGSVGElement>("lWave");
  const path = el<SVGPathElement>("lWavePath");
  if (!svg || !path) return;
  const width = svg.clientWidth || 1000;
  path.setAttribute("d", waveGeometry(width, WAVE_HEIGHT, energy));
}

/** The miniature trace inside the device screen. Same generator, tiny box. */
function drawScreenWave(): void {
  const path = el<SVGPathElement>("lScreenWave");
  if (!path) return;
  const parts: string[] = [];
  const x0 = 80, y0 = 118, w = 100, h = 14;
  for (let i = 0; i <= 60; i++) {
    const x = i / 60;
    const envelope = Math.pow(Math.sin(Math.PI * x), 0.5);
    const v = Math.sin(x * 30 + phase * 2.2) * 0.6 + Math.sin(x * 71 - phase) * 0.4;
    parts.push((i ? "L" : "M") + (x0 + x * w).toFixed(1) + " " +
      (y0 + v * envelope * h * 0.5).toFixed(1));
  }
  path.setAttribute("d", parts.join(" "));
}

function loop(): void {
  frame = 0;
  phase += 0.045;
  // Scroll adds energy; it decays back to rest on its own.
  energy += (REST_ENERGY - energy) * 0.05;
  drawWave();
  drawScreenWave();
  if (isOnScreen()) frame = requestAnimationFrame(loop);
}

function isOnScreen(): boolean {
  const landing = el("landingMode");
  return landing !== null && !landing.hidden;
}

function onScroll(): void {
  energy = Math.min(MAX_ENERGY, energy + Math.abs(window.scrollY - lastScrollY) * 0.012);
  lastScrollY = window.scrollY;
}

/** Count the device timecode up to the value printed on the screen. */
function runTimecode(): void {
  const node = el("lTimecode");
  if (!node) return;
  const targetSeconds = 205;   // 00:03:25, as shown on the render
  const durationMs = 2600;
  const startedAt = performance.now();
  const step = (now: number): void => {
    const p = Math.min((now - startedAt) / durationMs, 1);
    const s = Math.floor(p * targetSeconds);
    node.textContent = "00:" + String(Math.floor(s / 60)).padStart(2, "0") +
      ":" + String(s % 60).padStart(2, "0");
    if (p < 1 && isOnScreen()) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Start or restart the page. Safe to call every time it is shown. */
export function startLanding(): void {
  // One frame drawn synchronously, before any scheduling. requestAnimationFrame
  // does not run in a hidden page — a background tab, or a headless browser —
  // so without this the waveform is an empty <path> until the page is looked
  // at, and it renders as a blank strip.
  drawWave();
  drawScreenWave();
  if (REDUCED) return;
  lastScrollY = window.scrollY;
  if (!frame) frame = requestAnimationFrame(loop);
  runTimecode();
}

export function stopLanding(): void {
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

export function initLanding(): void {
  const readout = el("lReadout");

  if (REDUCED) {
    if (readout) readout.style.opacity = "1";
    drawWave();
    drawScreenWave();
  } else {
    window.addEventListener("scroll", onScroll, { passive: true });
    // Fades in once the screen has "woken". Delayed rather than immediate so
    // the eye reads the device first and the caption second.
    readout?.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: 600, delay: 900, fill: "forwards" });
  }

  window.addEventListener("resize", drawWave);

  // The internals rise the first time they are reached.
  const exploded = document.querySelector(".lExploded");
  if (exploded && !REDUCED && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.25 });
    observer.observe(exploded);
  }

  startLanding();
}
