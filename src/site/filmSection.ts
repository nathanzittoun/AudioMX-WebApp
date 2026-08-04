// "From patient to accepted": the nine second run of the device, as video.
//
// This is the one moving thing on the page that is a <video> rather than a
// canvas fed by WebP frames, and the split is not taste. The hero and the
// closer look are *scrubbed* — one by a timer, one by the scroll position —
// and a video cannot be seeked frame-accurately from a handler: seeking is
// asynchronous and lands on the nearest keyframe. This film only ever plays
// forward, which is the case a video wins outright, at 530 kB against the
// 3.2 MB the same nine seconds would cost as frames.
//
// Everything below exists to answer one question: the visitor is somewhere on
// a long page, and the film is nine seconds long. It must not have finished
// before they arrive, and it must not have cost them anything if they never do.

import { el } from "../ui/dom";

/**
 * Where each chapter starts, in seconds, read off the film frame by frame:
 * 0.00 the patient list and the chart, 3.00 the task list, 4.50 the take
 * running, 7.00 the take accepted. These are properties of the file. Recut the
 * film and these move with it, or the copy describes the wrong picture.
 */
const CHAPTER_STARTS = [0, 3.0, 4.5, 7.0];

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How close the section has to get before the file is worth fetching, in
 *  viewport heights. One and a half is roughly two seconds of unhurried
 *  scrolling, which is longer than the fetch. */
const FETCH_WITHIN = 1.5;

export function initFilmSection(): void {
  const video = el<HTMLVideoElement>("inUseFilm");
  const stage = document.querySelector<HTMLElement>(".film-stage");
  const button = document.querySelector<HTMLButtonElement>(".film-button");
  const label = button?.querySelector("b");
  const chapters = [...document.querySelectorAll<HTMLElement>(".film-chapters li")];
  if (!video || !stage) return;

  let requested = false;   // the file has been asked for
  let started = false;     // the film has been played at least once
  let shown = -1;          // which chapter is lit, so the DOM is left alone otherwise
  let raf = 0;

  // No aria-label: the visible word is already the accessible name, and a
  // label that does not contain the visible text breaks voice control, which
  // asks for the button by what is written on it.
  const setButton = (text: string, icon: string, hidden: boolean): void => {
    if (!button) return;
    if (label) label.textContent = text;
    const glyph = button.querySelector(".film-button-icon");
    if (glyph) glyph.textContent = icon;
    button.classList.toggle("is-hidden", hidden);
  };

  /** The film's own length once it is known, and its nominal length until then:
   *  duration reads NaN before metadata has loaded, and NaN propagates into
   *  every rail on the page. */
  const duration = (): number => (Number.isFinite(video.duration) ? video.duration : 9);

  /**
   * Light the chapter the film is inside and fill the rails behind it.
   *
   * Called from both a rAF loop and `timeupdate`, on purpose. rAF is smooth
   * enough for the rail but does not run at all in a document whose
   * visibilityState is "hidden"; Chrome will happily keep a muted video playing
   * in a background tab, and without the timeupdate path the chapters would
   * freeze while the film ran on underneath them. timeupdate alone fires about
   * four times a second, which is fine for the chapter and visibly steps the
   * rail. Together they cost nothing and neither can be the only one.
   */
  const sync = (): void => {
    const t = video.currentTime;
    let current = 0;
    for (let i = 0; i < CHAPTER_STARTS.length; i++) {
      if (t >= CHAPTER_STARTS[i]!) current = i;
    }

    chapters.forEach((li, i) => {
      const start = CHAPTER_STARTS[i];
      const span = li.querySelector<HTMLElement>("i span");
      if (start === undefined || !span) return;
      const end = CHAPTER_STARTS[i + 1] ?? duration();
      const filled = Math.min(Math.max((t - start) / (end - start), 0), 1);
      span.style.transform = `scaleX(${filled})`;
    });

    if (current === shown) return;
    shown = current;
    chapters.forEach((li, i) => li.classList.toggle("is-active", i === current));
  };

  const tick = (): void => {
    sync();
    raf = video.paused || video.ended ? 0 : requestAnimationFrame(tick);
  };

  /**
   * Try to play, and treat a refusal as a state rather than as an error.
   *
   * play() returns a promise that rejects when the browser declines, and muted
   * autoplay is declined more often than it looks: iOS Low Power Mode, a
   * Firefox setting, a managed browser policy. A rejection handled as a silent
   * catch leaves a poster with no way to start it, which is a dead rectangle in
   * the middle of the page. Handled here it just means the button stays.
   */
  const play = (): void => {
    requested = true;
    video.play().then(
      () => {
        started = true;
        setButton("Replay", "↻", true);
        if (!raf) raf = requestAnimationFrame(tick);
      },
      () => setButton(started ? "Replay" : "Play", started ? "↻" : "▶", false)
    );
  };

  video.addEventListener("timeupdate", sync);
  video.addEventListener("ended", () => {
    sync();
    setButton("Replay", "↻", false);
  });
  // A film that cannot load must not leave a control that cannot do anything.
  // The poster stays, and the section still reads.
  video.addEventListener("error", () => button?.remove());

  button?.addEventListener("click", () => {
    if (video.ended || video.currentTime >= duration() - 0.05) video.currentTime = 0;
    play();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-chapter]").forEach(node => {
    node.addEventListener("click", () => {
      const i = Number(node.dataset["chapter"]);
      video.currentTime = CHAPTER_STARTS[i] ?? 0;
      sync();
      play();
    });
  });

  /**
   * Fetch when the section is near, play when it is actually on screen.
   *
   * A scroll listener with a rectangle test rather than an IntersectionObserver,
   * for the same measured reason as the reveals in main.ts: in a document whose
   * visibilityState is "hidden" the observer never fires at all. Here that
   * failure would be invisible — a poster that never becomes a film — which is
   * exactly the shape of bug this page has already shipped once.
   *
   * The scroll listener has the same blind spot, and that is the right answer
   * for playback: a film nobody can see should not be playing. The difference
   * is that it recovers the moment the tab is looked at, and an observer that
   * never fired does not.
   */
  const watch = (): void => {
    const box = stage.getBoundingClientRect();
    const h = window.innerHeight;

    if (!requested && box.top < h * (1 + FETCH_WITHIN) && box.bottom > 0) {
      // preload="none" in the markup is what kept this off the critical path.
      // Raising it here is the fetch; load() without it is a no-op. It happens
      // under reduced motion too: that setting means the film should not start
      // by itself, not that a visitor who presses Play should then wait for it.
      video.preload = "auto";
      video.load();
      requested = true;
    }

    // Two thirds on screen, not merely touching it: at the moment the top edge
    // appears the film is one line of pixels tall and the first second is lost.
    const visible = Math.min(box.bottom, h) - Math.max(box.top, 0);
    if (!started && visible > box.height * 0.66) {
      // Asked for less movement means the film waits to be asked for. The
      // poster, the button and the chapters carry the section on their own.
      if (REDUCED) return;
      window.removeEventListener("scroll", watch);
      window.removeEventListener("resize", watch);
      play();
    }
  };

  // Visible from the start, and hidden only once the film is actually running.
  // The other way round reads better for the visitor who scrolls here and gets
  // an autoplay, and is a dead poster for every visitor who does not: one who
  // never scrolls this far in a tab that was opened in the background, one
  // whose browser declines, one on a connection where the file is still coming.
  setButton("Play", "▶", false);
  sync();
  watch();
  window.addEventListener("scroll", watch, { passive: true });
  window.addEventListener("resize", watch, { passive: true });
}
