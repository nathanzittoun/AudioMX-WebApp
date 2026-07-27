// Runs AFTER every legacy script — the application entry point.
//
// The counterpart to bridge.ts: where that one feeds converted code down into
// the legacy world, this one is the top of the app, and the migration pulls
// code down into it from above. Everything legacy main.js used to do at the
// bottom of index.html happens here.

export {};
