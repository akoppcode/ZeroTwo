import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("reports the bridge as disconnected from the real not_connected JSON", async () => {
    const desktop = new DesktopService(mockRunner({ ZT_MOCK_PBID_STATUS: "not_connected" }));
    const status = await desktop.status();
    expect(status.connected).toBe(false);
    expect(status.instances).toEqual([]);
  });

  it('treats the real "ready" status (Desktop up, bridge connected) as connected', async () => {
    const readyJson = JSON.stringify({
      status: "ready",
      instances: [
        {
          pid: 23232,
          bridgeStatus: "connected",
          currentFilePath: "C:\\reports\\Sales\\Sales.pbip",
        },
      ],
    });
    const runner: CliRunner = async (_bin, argv) =>
      argv[0] === "status"
        ? { code: 0, stdout: readyJson, stderr: "" }
        : { code: 1, stdout: "", stderr: "unexpected" };
    const status = await new DesktopService(runner).status();
    expect(status.connected).toBe(true);
    expect(status.instances[0]).toEqual({ pid: 23232, title: "C:\\reports\\Sales\\Sales.pbip" });
  });

  it("reports the cached manifest capability list", async () => {
    const desktop = new DesktopService(mockRunner());
    expect(await desktop.manifest()).toContain("screenshot-all");
  });

  it("normalizes real bridge screenshots (named by display name) to <pageId>.png", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zt-shot-real-"));
    const displayName = "1 Category Performance";
    const outputPath = join(dir, `${displayName}.png`);
    const runner: CliRunner = async (_bin, argv) => {
      expect(argv[0]).toBe("screenshot-all");
      writeFileSync(outputPath, Buffer.from(""));
      return {
        code: 0,
        stdout: JSON.stringify({
          status: "ok",
          screenshots: [{ pageId: "page1_catperf", pageDisplayName: displayName, outputPath }],
          failures: [],
        }),
        stderr: "",
      };
    };
    const pages = await new DesktopService(runner).screenshotAll(dir);
    expect(pages).toEqual(["page1_catperf"]);
    expect(existsSync(join(dir, "page1_catperf.png"))).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
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

  it("opens Power BI Desktop when the bridge is not connected instead of reloading", async () => {
    const calls: string[][] = [];
    const runner: CliRunner = async (_bin, argv) => {
      calls.push(argv);
      const cmd = argv[0];
      if (cmd === "status") {
        return { code: 0, stdout: JSON.stringify({ status: "not_connected", instances: [] }), stderr: "" };
      }
      if (cmd === "open" || cmd === "reload") return { code: 0, stdout: "ok", stderr: "" };
      if (cmd === "screenshot-all") {
        const outDir = argv[argv.indexOf("--output-dir") + 1]!;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "overview.png"), Buffer.from(""));
        return { code: 0, stdout: JSON.stringify({ pages: ["overview"] }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unsupported ${cmd}` };
    };
    const pipeline = new PipelineService(deps({ desktop: new DesktopService(runner) }));
    const result = await pipeline.run({
      ...baseOpts(join(root, ".zerotwo", "screenshots", "run-open")),
      openPath: join(root, "Report.pbip"),
    });

    expect(result.ok).toBe(true);
    const commands = calls.map((c) => c[0]);
    expect(commands).toContain("open");
    expect(commands).not.toContain("reload");
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
