// A very small typed event bus.
//
// It exists to fix a direction problem. The recorder and the storage layer both
// need the views to refresh after they change the library — but core/ and
// storage/ importing a view from rnd/ would invert the dependency and make the
// lower layers unusable without the R&D UI present. Now they announce what
// happened and whoever cares subscribes.
//
// Notification only, never state: the data still lives in state.ts. An event
// that carried state would just be a second source of truth.

/** Closed map of events. A typo in a name is a compile error, unlike a string bus. */
export interface Events {
  /** The set of saved takes changed — added, renamed, deleted or reloaded. */
  "library:changed": void;
  /** A take finished saving. Carries the take itself. */
  "recording:saved": unknown;
}

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

// Stored untyped and cast at the two public boundaries. A per-key mapped type
// cannot be written to generically — TypeScript has no way to know that the
// handler and the payload came from the same K.
type AnyHandler = (payload: never) => void;

const handlers = new Map<keyof Events, Set<AnyHandler>>();

/** Subscribe. Returns an unsubscribe function. */
export function on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const stored = handler as AnyHandler;
  set.add(stored);
  return () => { set.delete(stored); };
}

export function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const stored of set) {
    const handler = stored as Handler<K>;
    // One bad subscriber must not stop the others, nor take down the caller —
    // which is often mid-save with audio that cannot be recorded again.
    try {
      handler(payload);
    } catch (e) {
      console.warn(`Handler for "${event}" threw:`, e);
    }
  }
}
