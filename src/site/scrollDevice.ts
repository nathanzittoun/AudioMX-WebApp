// "A closer look": the same 150 frames, scrubbed by the scroll position.
//
// The section is taller than the viewport and its inner block is sticky, so the
// device holds still while the page moves behind it and the scroll offset maps
// straight onto a frame index. That mapping is the whole effect.

import { FRAME_COUNT, loadFrames, paintFrame, sizeCanvas } from "./frames";
import { el } from "../ui/dom";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where a reader who asked for reduced motion is parked: mid-rotation, which
 *  is the most legible single frame of the sequence. */
const STILL_AT = 0.48;

const CHAPTERS = 3;

export function initScrollDevice(): void {
  const section = document.querySelector<HTMLElement>(".scroll-product-section");
  const canvas = el<HTMLCanvasElement>("closerCanvas");
  const bar = document.querySelector<HTMLElement>(".scroll-progress i span");
  const index = document.querySelector<HTMLElement>(".scroll-progress b");
  const chapters = [...document.querySelectorAll<HTMLElement>(".scroll-chapter")];
  if (!section || !canvas) return;

  let queued = 0;
  let shown = -1;

  loadFrames().then(all => {
    const resize = () => {
      sizeCanvas(canvas, 620);
      update();
    };

    function update(): void {
      queued = 0;
      const box = section!.getBoundingClientRect();
      // How far the sticky block can travel: the section's overflow past one
      // viewport. Clamped at 1 so a section shorter than the viewport — which
      // happens on a short phone in landscape — divides by a sane number
      // instead of producing Infinity.
      const travel = Math.max(box.height - window.innerHeight, 1);
      const progress = REDUCED
        ? STILL_AT
        : Math.min(Math.max(-box.top / travel, 0), 1);

      paintFrame(canvas!, all, Math.round(progress * (FRAME_COUNT - 1)));
      if (bar) bar.style.transform = `scaleX(${progress})`;

      // Chapters change at even thirds. Only touch the DOM when the answer
      // actually changed — this runs on every scroll frame.
      const chapter = Math.min(CHAPTERS - 1, Math.floor(progress * CHAPTERS));
      if (chapter === shown) return;
      shown = chapter;
      chapters.forEach((node, i) => node.classList.toggle("is-active", i === chapter));
      if (index) index.textContent = String(chapter + 1).padStart(2, "0");
    }

    const schedule = () => {
      // Coalesce to one paint per frame. A scroll event can fire many times
      // between two frames, and each extra call would decode and draw an image
      // nobody ever sees.
      if (queued) return;
      queued = requestAnimationFrame(update);
    };

    resize();
    canvas.classList.add("is-ready");
    document.querySelector(".scroll-product-loader")?.remove();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", resize);
  });
}
