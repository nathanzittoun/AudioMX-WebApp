// The hero: the device turns once, on arrival, and the headline lands with it.
//
// Timed rather than scroll-driven, because this one plays before the visitor
// has scrolled anything. The scrubbed version of the same footage is the
// "closer look" section further down (scrollDevice.ts).

import { FRAME_COUNT, loadFrames, paintFrame, sizeCanvas } from "./frames";
import { el } from "../ui/dom";

const FPS = 30;

/** The frame the device has turned far enough for the headline to belong to it.
 *  Copy that arrives before this reads as a caption on a still. */
const COPY_LANDS_AT = 92;

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

let animation = 0;

export function initHeroSequence(): void {
  const canvas = el<HTMLCanvasElement>("heroCanvas");
  const copy = document.querySelector<HTMLElement>(".hero-copy");
  const loader = document.querySelector<HTMLElement>(".sequence-loader span");
  const replay = document.querySelector<HTMLButtonElement>(".replay-button");
  if (!canvas) return;

  const showCopy = (on: boolean) => copy?.classList.toggle("is-visible", on);

  loadFrames(n => {
    if (loader) loader.style.width = Math.round((n / FRAME_COUNT) * 100) + "%";
  }).then(all => {
    const resize = () => {
      sizeCanvas(canvas, 720);
      // Repaint after resizing: changing canvas.width clears the buffer, so a
      // resize with no repaint leaves the hero blank until the next frame.
      paintFrame(canvas, all, FRAME_COUNT - 1);
    };
    resize();
    window.addEventListener("resize", resize);
    canvas.classList.add("is-ready");
    document.querySelector(".sequence-loader")?.remove();

    // Reduced motion gets the finished state, not a frozen first frame: the
    // point of the animation is where it ends up, and a visitor who asked the
    // system for less movement should still see the product.
    if (REDUCED) {
      paintFrame(canvas, all, FRAME_COUNT - 1);
      showCopy(true);
      return;
    }

    const play = () => {
      if (animation) cancelAnimationFrame(animation);
      showCopy(false);
      replay?.classList.remove("is-visible");
      const startedAt = performance.now();
      let landed = false;

      // The headline must not depend on the animation reaching frame 92.
      // requestAnimationFrame does not run at all in a document whose
      // visibilityState is "hidden" — a background tab, a headless browser — so
      // a visitor who opens this page in a new tab and switches to it later
      // would find a hero with no words in it. Timers still fire there, so this
      // is the floor: whichever of the two arrives first reveals the copy, and
      // the rAF path stays in charge whenever the page is actually on screen.
      const floor = window.setTimeout(() => {
        landed = true;
        showCopy(true);
      }, (COPY_LANDS_AT / FPS) * 1000);

      const step = (now: number) => {
        // Driven by elapsed time, not by a counter: a dropped frame then costs
        // one missed image rather than sliding the whole sequence late.
        const i = Math.min(
          FRAME_COUNT - 1,
          Math.floor(((now - startedAt) / 1000) * FPS)
        );
        paintFrame(canvas, all, i);
        if (!landed && i >= COPY_LANDS_AT) {
          landed = true;
          showCopy(true);
        }
        if (i < FRAME_COUNT - 1) {
          animation = requestAnimationFrame(step);
        } else {
          animation = 0;
          clearTimeout(floor);
          showCopy(true);
          replay?.classList.add("is-visible");
        }
      };
      animation = requestAnimationFrame(step);
    };

    replay?.addEventListener("click", play);
    play();
  });
}
