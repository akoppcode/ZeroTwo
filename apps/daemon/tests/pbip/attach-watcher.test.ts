import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { watchForPbip } from "../../src/pbip/attach-watcher.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures");
const FAST = { debounceMs: 150, timeoutMs: 15000 };

describe("watchForPbip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zt-watch-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves 'found' once a valid PBIR project appears in the watched folder", async () => {
    const watch = watchForPbip(dir, FAST);
    // Simulate the Save As landing the project a moment later.
    setTimeout(() => void cp(join(FIXTURES, "sample.pbip"), dir, { recursive: true }), 200);
    const result = await watch;
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.root).toBe(dir);
    expect(result.inspect.report.pages).toHaveLength(2);
  });

  it("resolves 'legacy' when a PBIR-legacy report is saved", async () => {
    const watch = watchForPbip(dir, FAST);
    setTimeout(() => void cp(join(FIXTURES, "legacy-sample.pbip"), dir, { recursive: true }), 200);
    const result = await watch;
    expect(result.status).toBe("legacy");
    if (result.status !== "legacy") return;
    expect(result.message).toMatch(/enhanced report format/i);
  });

  it("resolves 'aborted' when the wizard is cancelled", async () => {
    const ac = new AbortController();
    const watch = watchForPbip(dir, { ...FAST, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect((await watch).status).toBe("aborted");
  });

  it("resolves 'timeout' when no project appears", async () => {
    const result = await watchForPbip(dir, { debounceMs: 50, timeoutMs: 400 });
    expect(result.status).toBe("timeout");
  });
});
