import { rename as renamePromise } from 'node:fs/promises';
import { renameSync } from 'node:fs';

/**
 * Windows `MoveFileEx` throws EPERM/EACCES when a concurrent reader holds the
 * destination (or an AV/indexer has it open transiently), where POSIX `rename`
 * would succeed atomically. These helpers retry the rename a few times with a
 * short backoff so a routine write-through-temp-file swap doesn't fail on a
 * transient lock. Non-lock errors propagate immediately.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_BACKOFF_MS = 20;

// Capture the real timer at module load. Callers (notably tests) may install
// fake timers via vitest; the retry backoff must still fire real time, or a
// rename that needs a retry would hang forever when the faked timer never runs.
const realSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout;

function isRetryableRenameError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code != null && RENAME_RETRY_CODES.has(code);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });

/** Real, blocking sleep for the synchronous path — immune to faked timers and
 *  frozen `Date.now`. Uses Atomics.wait on a throwaway shared buffer. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renamePromise(source, target);
      return;
    } catch (err) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !isRetryableRenameError(err)) throw err;
      await sleep(RENAME_BACKOFF_MS * attempt);
    }
  }
}

export function renameSyncWithRetry(source: string, target: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (err) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !isRetryableRenameError(err)) throw err;
      sleepSync(RENAME_BACKOFF_MS * attempt);
    }
  }
}
