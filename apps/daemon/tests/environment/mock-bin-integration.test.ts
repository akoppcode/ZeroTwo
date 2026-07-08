import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  runDoctorChecks,
  type CommandResult,
  type CommandRunner,
} from "../../src/environment/environment-service.js";

// Repo root is four levels up from apps/daemon/tests/environment/.
const MOCK_BIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "mock-bin",
);

const MOCK_SCRIPTS: Record<string, string> = {
  "powerbi-desktop": "powerbi-desktop.mjs",
  "powerbi-report-author": "powerbi-report-author.mjs",
  "fab-inspector": "fab-inspector.mjs",
  claude: "claude.mjs",
  copilot: "copilot.mjs",
};

/** A real-spawn CommandRunner that routes known tool names to the mock-bin
 *  fakes (run via `node <mock>.mjs`) with the given scenario env, and reports
 *  `notFound` for anything not in the mock set or explicitly disabled. This
 *  exercises the true spawn + stdout/stderr parse path, unlike the unit tests
 *  which inject canned results. */
function mockBinRunner(scenarioEnv: Record<string, string>, disabled: Set<string> = new Set()): CommandRunner {
  return (command, args) =>
    new Promise<CommandResult>((resolve) => {
      // `git` is a real tool the mock set doesn't emulate; the healthy scenario
      // relies on git being present on the test machine, so pass it through.
      const script = MOCK_SCRIPTS[command];
      if (!script || disabled.has(command)) {
        if (command === "git") {
          // fall through to a real spawn below
        } else {
          resolve({ code: null, stdout: "", stderr: "", notFound: true });
          return;
        }
      }
      const spawnArgs = script && !disabled.has(command) ? [join(MOCK_BIN_DIR, script), ...args] : args;
      const spawnCmd = script && !disabled.has(command) ? process.execPath : command;
      let stdout = "";
      let stderr = "";
      const child = spawn(spawnCmd, spawnArgs, {
        env: { ...process.env, ...scenarioEnv },
        windowsHide: true,
      });
      child.stdout?.on("data", (c) => (stdout += c.toString()));
      child.stderr?.on("data", (c) => (stderr += c.toString()));
      child.on("error", (err) =>
        resolve({
          code: null,
          stdout,
          stderr,
          notFound: (err as NodeJS.ErrnoException).code === "ENOENT",
        }),
      );
      child.on("close", (code) => resolve({ code, stdout, stderr, notFound: false }));
    });
}

const BASE = {
  now: "2026-07-08T00:00:00.000Z",
  platform: "win32" as NodeJS.Platform,
  osRelease: "10.0.22631",
  arch: "x64",
  nodeVersion: "v20.11.0",
};

describe("EnvironmentService against the mock-bin fakes (real spawn)", () => {
  it("classifies a healthy environment as ok by spawning the fakes", async () => {
    const report = await runDoctorChecks({
      ...BASE,
      detectPowerBiDesktopVersion: async () => "2.155.756.0",
      runCommand: mockBinRunner({ ZT_MOCK_PBID_STATUS: "connected", ZT_MOCK_CLAUDE_LOGGED_IN: "1" }),
    });
    // git may or may not be signed off; the tool checks that matter here are the
    // spawned fakes. Assert each spawned-fake check parsed to ok.
    for (const id of ["desktop-bridge-cli", "report-authoring-cli", "fab-inspector", "desktop-bridge", "claude", "copilot"]) {
      expect(report.checks.find((c) => c.id === id)?.status, id).toBe("ok");
    }
    expect(report.checks.find((c) => c.id === "desktop-bridge")?.detected).toBe("connected");
  });

  it("parses the not_connected bridge status from the fake into a warning", async () => {
    const report = await runDoctorChecks({
      ...BASE,
      detectPowerBiDesktopVersion: async () => "2.155.756.0",
      runCommand: mockBinRunner({ ZT_MOCK_PBID_STATUS: "not_connected" }),
    });
    expect(report.checks.find((c) => c.id === "desktop-bridge")?.status).toBe("warning");
  });

  it("parses a signed-out agent (fake exits non-zero) into a warning", async () => {
    const report = await runDoctorChecks({
      ...BASE,
      detectPowerBiDesktopVersion: async () => "2.155.756.0",
      runCommand: mockBinRunner({ ZT_MOCK_CLAUDE_LOGGED_IN: "0", ZT_MOCK_COPILOT_LOGGED_IN: "1" }),
    });
    expect(report.checks.find((c) => c.id === "claude")?.status).toBe("warning");
    expect(report.checks.find((c) => c.id === "copilot")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "agents")?.status).toBe("ok");
  });

  it("treats an absent fake (not on the runner) as an error", async () => {
    const report = await runDoctorChecks({
      ...BASE,
      detectPowerBiDesktopVersion: async () => "2.155.756.0",
      runCommand: mockBinRunner({}, new Set(["fab-inspector"])),
    });
    expect(report.checks.find((c) => c.id === "fab-inspector")?.status).toBe("error");
  });
});
