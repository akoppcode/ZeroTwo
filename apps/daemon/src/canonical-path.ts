import { realpath as realpathCallback } from "node:fs";
import { promisify } from "node:util";

/**
 * realpath that resolves the OS's *native* canonical form. Crucially on Windows
 * this collapses 8.3 short names (e.g. `C:\Users\RUNNER~1\…` -> `…\runneradmin\…`)
 * that the JS `fs.promises.realpath` leaves intact. Path-containment / escape
 * checks must compare native-canonical forms, or a symlink whose target only
 * differs by short-vs-long name slips past the "is this inside the boundary?"
 * comparison (a real Windows path-traversal gap). On POSIX it behaves like the
 * C `realpath` (also resolving symlinks, /var -> /private/var, etc.).
 */
export const realpathNative: (path: string) => Promise<string> = promisify(realpathCallback.native);
