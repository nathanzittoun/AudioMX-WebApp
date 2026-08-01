// The 150-frame product animation, loaded once and shared.
//
// Two places on the page draw this same sequence: the hero plays it straight
// through on arrival, and the "closer look" section scrubs it with the scroll
// position. They must not each fetch 3.2 MB — hence one module holding one
// array of images that both wait on.
//
// Frames rather than a video, and that is a deliberate trade. A <video> cannot
// be seeked frame-accurately from a scroll handler in any browser: seeking is
// asynchronous, lands on the nearest keyframe, and stutters. Painting a decoded
// image into a canvas is synchronous and exact. The cost is bytes, which is why
// they are WebP and why the service worker refuses to cache them.

export const FRAME_COUNT = 150;

/** Native frame aspect, used to size the canvas without reading an image. */
export const FRAME_RATIO = 1160 / 900;

const framePath = (n: number) =>
  `${import.meta.env.BASE_URL}site/hero/h_${String(n).padStart(4, "0")}.webp`;

let frames: HTMLImageElement[] | null = null;
let ready: Promise<HTMLImageElement[]> | null = null;
let loaded = 0;
const listeners = new Set<(loaded: number) => void>();

/**
 * Start (or join) the load. Resolves once every frame has settled.
 *
 * `onerror` counts as settled, exactly like `onload`. A missing frame must not
 * hang the page forever waiting for a promise that can no longer resolve — the
 * sequence simply skips that frame, which is invisible at 30 fps.
 */
export function loadFrames(onProgress?: (loaded: number) => void): Promise<HTMLImageElement[]> {
  if (onProgress) {
    listeners.add(onProgress);
    onProgress(loaded);
  }

  if (!frames) {
    frames = Array.from({ length: FRAME_COUNT }, (_, i) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = image.onerror = () => {
        loaded += 1;
        listeners.forEach(listener => listener(loaded));
      };
      image.src = framePath(i + 1);
      return image;
    });
  }

  if (!ready) {
    ready = new Promise(resolve => {
      const check = (n: number) => {
        if (n !== FRAME_COUNT || !frames) return;
        listeners.delete(check);
        resolve(frames);
      };
      listeners.add(check);
      check(loaded);
    });
  }

  return ready.then(all => {
    if (onProgress) listeners.delete(onProgress);
    return all;
  });
}

/**
 * Paint one frame, scaled to the canvas.
 *
 * Guards on `complete` and `naturalWidth`: drawImage() with an image that
 * errored throws, and one frame failing must not take the whole sequence with
 * it.
 */
export function paintFrame(
  canvas: HTMLCanvasElement,
  all: HTMLImageElement[],
  index: number
): void {
  const image = all[index];
  if (!image?.complete || !image.naturalWidth) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
}

/**
 * Size the canvas backing store to its laid-out width.
 *
 * Capped at 2× device pixels: a 3× phone would allocate a buffer nine times the
 * CSS area for a difference nobody can see, and 150 frames are already the
 * expensive part of this page.
 */
export function sizeCanvas(canvas: HTMLCanvasElement, fallbackWidth: number): void {
  const width = canvas.getBoundingClientRect().width || fallbackWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(width * FRAME_RATIO * dpr);
}
