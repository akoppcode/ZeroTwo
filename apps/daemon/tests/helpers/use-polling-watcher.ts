// Side-effect module: select chokidar's polling mode for the importing test
// file by setting OD_WATCHER_USE_POLLING before the daemon's project-watcher
// module captures the flag at import time. Import it BEFORE any '../src/…'
// import so it lands first.
//
// Why: on Windows, native fs.watch (ReadDirectoryChangesW) holds directory
// handles on the watched project tree. When a project-events SSE stream is
// open, that watcher races the daemon's atomic directory rename under
// `.live-artifacts/` (live-artifacts/store.ts) and intermittently fails it with
// EPERM. Polling is a handle-free, product-supported watch mode — the daemon
// itself falls back to it on FS faults — so selecting it removes the race
// without changing any asserted behaviour (the live-artifact SSE events come
// from the daemon's event bus, not from the fs watcher).
if (!process.env.OD_WATCHER_USE_POLLING) {
  process.env.OD_WATCHER_USE_POLLING = '1';
}
