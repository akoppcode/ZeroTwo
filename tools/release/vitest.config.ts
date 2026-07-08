import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The channel-prepare tests each spawn several release-prepare subprocesses
    // plus a metadata HTTP server; on Windows (CI runner + slower FS) that
    // exceeds the 5s default and times out. Give them room.
    testTimeout: 30_000,
  },
});
