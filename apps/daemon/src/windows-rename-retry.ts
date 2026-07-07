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

function isRetryableRenameError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code != null && RENAME_RETRY_CODES.has(code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const deadline = Date.now() + RENAME_MAX_ATTEMPTS * RENAME_BACKOFF_MS * 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (err) {
      if ((attempt >= RENAME_MAX_ATTEMPTS && Date.now() >= deadline) || !isRetryableRenameError(err)) {
        throw err;
      }
      // Synchronous busy-wait backoff (callers are already on a sync path).
      const until = Date.now() + RENAME_BACKOFF_MS * attempt;
      while (Date.now() < until) { /* spin */ }
    }
  }
}
