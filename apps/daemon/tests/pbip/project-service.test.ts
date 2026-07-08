import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectService } from "../../src/pbip/project-service.js";
import { GitService } from "../../src/git/git-service.js";
import { inspectPbip } from "../../src/pbip/pbip-inspect.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures");

describe("ProjectService", () => {
  let work: string;
  const svc = new ProjectService();
  const git = new GitService();

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "zt-proj-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("attaches the PBIR sample: correct inventory + baseline commit", async () => {
    const dest = join(work, "sample");
    await cp(join(FIXTURES, "sample.pbip"), dest, { recursive: true });

    const outcome = await svc.attach(dest, "claude");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.project).toMatchObject({
      kind: "attached",
      agent: "claude",
      pbipFile: "Sample.pbip",
      reportDirName: "Sample.Report",
      hasSemanticModel: true,
      semanticModelTmdl: true,
      pageCount: 2,
      visualCount: 6,
    });
    // A baseline commit was made and the repo is real.
    expect(outcome.project.baselineSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.isRepo(dest)).toBe(true);
    expect(await git.headSha(dest)).toBe(outcome.project.baselineSha);
  });

  it("rejects a legacy PBIP with the enhanced-format guidance", async () => {
    const dest = join(work, "legacy");
    await cp(join(FIXTURES, "legacy-sample.pbip"), dest, { recursive: true });

    const outcome = await svc.attach(dest, "copilot");
    expect(outcome).toMatchObject({ ok: false, code: "pbir-legacy" });
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/enhanced report format/i);
  });

  it("scaffolds a new PBIR project that inspects clean and is committed", async () => {
    const dest = join(work, "new-report");
    const outcome = await svc.scaffold(dest, "Sales Overview", "claude");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.project).toMatchObject({
      kind: "scaffolded",
      pbipFile: "Sales Overview.pbip",
      reportDirName: "Sales Overview.Report",
      hasSemanticModel: true,
      semanticModelTmdl: true,
      pageCount: 1,
      visualCount: 0,
    });
    // The scaffolded project is itself a valid PBIR project per the inspector.
    const reinspect = await inspectPbip(dest);
    expect(reinspect.ok).toBe(true);
    expect(outcome.project.baselineSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
