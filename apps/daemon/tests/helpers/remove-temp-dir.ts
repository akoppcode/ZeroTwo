import { rm } from 'node:fs/promises';

/**
 * Best-effort recursive removal of a throwaway temp dir.
 *
 * On Windows the daemon keeps the SQLite file handle open a beat after it
 * closes, so an immediate unlink can fail transiently with EBUSY / EPERM (and
 * ENOTEMPTY as children clear). Retry those a few times, and on the final
 * attempt give up silently: a stuck temp-dir cleanup must never fail the test.
 * Any non-lock error is rethrown so a genuine bug is not masked.
 */
export async function removeTempDirBestEffort(target: string): Promise<void> {
  const retryable = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'ENOENT']);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!retryable.has(code)) throw error;
      if (attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
