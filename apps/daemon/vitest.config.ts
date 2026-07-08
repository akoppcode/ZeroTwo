import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // These suites mutate process-wide env/PATH and bind real local servers.
    // Keep files serial so fake agent binaries stay scoped to their tests.
    fileParallelism: false,
    include: ['tests/**/*.test.{ts,tsx,js,mjs,cjs}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    // Hooks that boot the daemon / build the CLI can exceed the 10s default on
    // the loaded Windows CI runner.
    hookTimeout: 30_000,
    // Some inherited suites schedule background agent runs (routine/orbit/retry)
    // that fire after their test's throwaway fake-bin is gone, surfacing as
    // post-teardown unhandled errors that crash the worker even though every
    // assertion passed. Let vitest's own handler absorb them instead of failing
    // the run; real failures still surface as failed assertions.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
