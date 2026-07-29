// Lazy, cached access to page elements.
//
// app.js captured ~45 elements into top-level consts the moment it loaded.
// That is why it can only ever run on index.html: any page missing one of
// those ids would either get null or, for the canvas contexts, throw outright
// while the script was still parsing. Resolving on first use instead means a
// module can be imported by a page that does not have every element.
//
// Results are cached, so repeated lookups cost nothing and identity is stable
// (the previous consts held one fixed reference each).

// Element, not HTMLElement: the landing page addresses <path> and <svg> nodes
// by id, and those are SVGElement. The default type parameter stays
// HTMLElement, so every existing call site is typed exactly as before.
const elementCache = new Map<string, Element | null>();
const contextCache = new Map<string, CanvasRenderingContext2D | null>();

/** The element, or null when the page does not have it. */
export function el<T extends Element = HTMLElement>(id: string): T | null {
  if (!elementCache.has(id)) {
    elementCache.set(id, document.getElementById(id));
  }
  return elementCache.get(id) as T | null;
}

/** The element, or a named error. Use where absence is a bug, not a variant. */
export function requireEl<T extends Element = HTMLElement>(id: string): T {
  const node = el<T>(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

/** 2D context for a canvas id, or null when the canvas is absent. */
export function ctx2d(canvasId: string): CanvasRenderingContext2D | null {
  if (!contextCache.has(canvasId)) {
    const canvas = el<HTMLCanvasElement>(canvasId);
    contextCache.set(canvasId, canvas ? canvas.getContext("2d") : null);
  }
  return contextCache.get(canvasId) ?? null;
}

/** Drop cached lookups. Only needed if the page swaps out live nodes. */
export function resetDomCache(): void {
  elementCache.clear();
  contextCache.clear();
}
