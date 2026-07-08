import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProvisioningService, parsePluginList } from "../../src/provisioning/provisioning-service.js";
import { detectAuth, guidedLoginCommand, type CliRunner } from "../../src/provisioning/auth-service.js";

const MOCK_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures", "mock-bin");

/** Run the mock .mjs CLI via node, threading ZT_MOCK_* env for state/failure. */
function mockRunner(extraEnv: NodeJS.ProcessEnv = {}): CliRunner {
  return (bin, argv, opts) =>
    new Promise((resolve) => {
      const mock = join(MOCK_BIN, `${bin}.mjs`);
      execFile(
        process.execPath,
        [mock, ...argv],
        { cwd: opts?.cwd, env: { ...process.env, ...extraEnv, ...opts?.env } },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
        },
      );
    });
}

describe("detectAuth", () => {
  it("reports signed-in + parses the account for claude", async () => {
    const status = await detectAuth("claude", mockRunner({ ZT_MOCK_CLAUDE_LOGGED_IN: "1", ZT_MOCK_CLAUDE_USER: "adrian@acme.no" }));
    expect(status).toMatchObject({ agent: "claude", loggedIn: true, user: "adrian@acme.no" });
  });

  it("reports signed-out for copilot and offers the login command", async () => {
    const status = await detectAuth("copilot", mockRunner({ ZT_MOCK_COPILOT_LOGGED_IN: "0" }));
    expect(status).toMatchObject({ agent: "copilot", loggedIn: false, user: null });
    expect(guidedLoginCommand("copilot")).toBe("copilot auth login");
  });
});

describe("parsePluginList", () => {
  it("parses ref + version lines", () => {
    expect(parsePluginList("pbip@power-bi-agentic-development  v26.25\nfoo@bar v1")).toEqual([
      { ref: "pbip@power-bi-agentic-development", version: "26.25" },
      { ref: "foo@bar", version: "1" },
    ]);
  });
});

describe("ProvisioningService.provision", () => {
  let cwd: string;
  let statePath: string;
  const svc = new ProvisioningService();

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "zt-prov-"));
    statePath = join(cwd, "plugin-state.json");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("issues the exact plan, verifies plugin list, and records zerotwo.json + ZERO_TWO.md", async () => {
    const report = await svc.provision("claude", {
      cwd,
      runner: mockRunner({ ZT_MOCK_PLUGIN_STATE: statePath, ZT_MOCK_PLUGIN_VERSION: "26.25" }),
    });

    // Exact command sequence was issued (spec §5.3 acceptance).
    expect(report.steps.map((s) => s.command)).toEqual([
      "/plugin marketplace add microsoft/skills-for-fabric",
      "/plugin marketplace add data-goblin/power-bi-agentic-development@v26.25",
      "/plugin install powerbi-authoring@fabric-collection",
      "/plugin install pbip@power-bi-agentic-development",
      "/plugin install pbi-desktop@power-bi-agentic-development",
      "/plugin install reports@power-bi-agentic-development",
      "/plugin install semantic-models@power-bi-agentic-development",
    ]);
    expect(report.steps.every((s) => s.ok)).toBe(true);
    expect(report.verified).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.installed).toHaveLength(5);

    const zerotwoJson = JSON.parse(await readFile(join(cwd, ".zerotwo", "zerotwo.json"), "utf8"));
    expect(zerotwoJson.agent).toBe("claude");
    expect(zerotwoJson.plugins.map((p: { ref: string }) => p.ref)).toContain("pbip@power-bi-agentic-development");

    expect(await readFile(join(cwd, "ZERO_TWO.md"), "utf8")).toContain("Operating contract");
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toMatch(/ZERO_TWO\.md/);
  });

  it("marks the run unverified when a plugin install fails", async () => {
    const report = await svc.provision("claude", {
      cwd,
      runner: mockRunner({ ZT_MOCK_PLUGIN_STATE: statePath, ZT_MOCK_PLUGIN_FAIL: "reports@power-bi-agentic-development" }),
    });
    const reportsStep = report.steps.find((s) => s.command.includes("reports@"));
    expect(reportsStep?.ok).toBe(false);
    expect(report.verified).toBe(false);
    expect(report.missing).toContain("reports@power-bi-agentic-development");
  });
});
