// The active storage implementation.
//
// One line changes when a backend exists: swap createIndexedDbStorage() for the
// REST-backed adapter and every call site follows, because they only ever see
// the Storage interface.

import { createIndexedDbStorage } from "./indexeddb";
import type { Storage } from "./types";

export const storage: Storage = createIndexedDbStorage();
export type { Storage } from "./types";
