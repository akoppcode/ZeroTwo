import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesktopService, type CliRunner } from "../../src/desktop/desktop-service.js";
import { PipelineService, type PipelineDeps, type StageEvent } from "../../src/desktop/pipeline-service.js";
import { GitService } from "../../src/git/git-service.js";

const MOCK_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures", "mock-bin");

function mockRunner(extraEnv: NodeJS.ProcessEnv = {}): CliRunner {
  return (bin, argv, opts) =>
    new Promise((resolve) => {
      const mock = join(MOCK_BIN, `${bin}.mjs`);
      execFile(process.execPath, [mock, ...argv], { cwd: opts?.cwd, env: { ...process.env, ...extraEnv, ...opts?.env } }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      });
    });
}

const okStage = async () => ({ ok: true, output: "ok" });

describe("DesktopService (mock bridge)", () => {
  it("parses status instances for the PID picker", async () => {
    const desktop = new DesktopService(mockRunner({ ZT_MOCK_PBID_INSTANCES: "1234:A.pbip;5678:B.pbip" }));
    const status = await desktop.status();
    expect(status.connected).toBe(true);
    expect(status.instances).toEqual([
      { pid: 1234, title: "A.pbip" },
      { pid: 5678, title: "B.pbip" },
    ]);
  });

  it("reports the cached manifest capability list", async () => {
    const desktop = new DesktopService(mockRunner());
    expect(await desktop.manifest()).toContain("screenshot-all");
  });

  it("captures screenshots to the out dir", async () => {
    const desktop = new DesktopService(mockRunner({ ZT_MOCK_PBID_PAGES: "overview,details" }));
    const dir = await mkdtemp(join(tmpdir(), "zt-shot-"));
    const pages = await desktop.screenshotAll(dir);
    expect(pages).toEqual(["overview", "details"]);
    expect(existsSync(join(dir, "overview.png"))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("PipelineService", () => {
  let root: string;
  const git = new GitService();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zt-pipe-"));
    await git.ensureRepo(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
    return {
      validate: okStage,
      inspect: okStage,
      desktop: new DesktopService(mockRunner({ ZT_MOCK_PBID_PAGES: "overview,details" })),
      git,
      ...overrides,
    };
  }

  const baseOpts = (runDir: string) => ({
    runId: "run-1",
    projectRoot: root,
    reportDir: join(root, "Sample.Report"),
    runDir,
    agentSummary: "chore: iterate",
  });

  it("runs the full pipeline green and produces screenshots + a commit", async () => {
    // Something to commit.
    await mkdtemp(join(tmpdir(), "x-")); // noop, keep timing similar
    const runDir = join(root, ".zerotwo", "screenshots", "run-1");
    const events: StageEvent[] = [];
    const pipeline = new PipelineService(deps());
    const result = await pipeline.run({ ...baseOpts(runDir), onEvent: (e) => events.push(e) });

    expect(result.ok).toBe(true);
    const order = events.filter((e) => e.status === "passed" || e.status === "skipped").map((e) => e.stage);
    expect(order).toEqual(["validate", "inspect", "reload", "screenshot", "commit"]);
    expect(result.screenshots?.pages).toEqual(["overview", "details"]);
    expect(existsSync(join(runDir, "overview.png"))).toBe(true);
  });

  it("auto-retries validate, feeding failure back to the agent, then passes", async () => {
    let attempt = 0;
    const validate = async () => {
      attempt += 1;
      return attempt < 3 ? { ok: false, output: `error #${attempt}` } : { ok: true, output: "passed" };
    };
    const fedBack: string[] = [];
    const pipeline = new PipelineService(
      deps({ validate, onValidateFailure: async (out) => { fedBack.push(out); return true; } }),
    );
    const result = await pipeline.run(baseOpts(join(root, ".zerotwo", "screenshots", "run-1")));
    expect(result.ok).toBe(true);
    expect(result.validateAttempts).toBe(3);
    expect(fedBack).toEqual(["error #1", "error #2"]);
  });

  it("stops and surfaces when validate keeps failing past the retry cap", async () => {
    const pipeline = new PipelineService(
      deps({ validate: async () => ({ ok: false, output: "still broken" }), onValidateFailure: async () => true }),
    );
    const result = await pipeline.run({ ...baseOpts(join(root, "r")), maxValidateAttempts: 3 });
    expect(result.ok).toBe(false);
    expect(result.validateAttempts).toBe(3);
  });

  it("returns a remediation when screenshot fails (bridge down)", async () => {
    const pipeline = new PipelineService(
      deps({ desktop: new DesktopService(mockRunner({ ZT_MOCK_PBID_SCREENSHOT: "fail" })) }),
    );
    const result = await pipeline.run(baseOpts(join(root, "r")));
    expect(result.ok).toBe(false);
    expect(result.remediation?.stage).toBe("screenshot");
  });
});
