import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitService, ZERO_TWO_GITIGNORE } from "../../src/git/git-service.js";

describe("GitService (real git, local repo)", () => {
  let dir: string;
  const git = new GitService();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zt-git-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("initializes a repo and writes the Zero Two .gitignore", async () => {
    expect(await git.isRepo(dir)).toBe(false);
    const { initialized } = await git.ensureRepo(dir);
    expect(initialized).toBe(true);
    expect(await git.isRepo(dir)).toBe(true);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(ZERO_TWO_GITIGNORE);
    // Idempotent: a second call does not re-init.
    expect((await git.ensureRepo(dir)).initialized).toBe(false);
  });

  it("makes a baseline commit and returns its sha, then no-ops on a clean tree", async () => {
    await git.ensureRepo(dir);
    await writeFile(join(dir, "report.json"), "{}", "utf8");
    const sha = await git.commitAll(dir, "chore(session): baseline");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.headSha(dir)).toBe(sha);
    // Nothing changed -> no new commit.
    expect(await git.commitAll(dir, "noop")).toBeNull();
  });

  it("lists commit history newest-first", async () => {
    await git.ensureRepo(dir);
    await writeFile(join(dir, "a.txt"), "1", "utf8");
    await git.commitAll(dir, "first");
    await writeFile(join(dir, "b.txt"), "2", "utf8");
    await git.commitAll(dir, "second");
    const log = await git.log(dir);
    expect(log.map((c) => c.subject)).toEqual(["second", "first"]);
    expect(log[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(log[0].shortSha.length).toBeGreaterThan(0);
    expect(log[0].authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("restores to an earlier commit (hard reset) after stashing dirty changes", async () => {
    await git.ensureRepo(dir);
    await writeFile(join(dir, "f.txt"), "v1", "utf8");
    const first = await git.commitAll(dir, "v1");
    await writeFile(join(dir, "f.txt"), "v2", "utf8");
    await git.commitAll(dir, "v2");
    // Dirty the tree, then restore to v1 — the safety stash must not block it.
    await writeFile(join(dir, "f.txt"), "uncommitted", "utf8");
    await git.restore(dir, first!);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("v1");
    expect(await git.headSha(dir)).toBe(first);
  });
});
