import { describe, expect, it } from "vitest";

import {
  compareVersions,
  runDoctorChecks,
  type CommandResult,
  type CommandRunner,
  type RunDoctorOptions,
} from "../../src/environment/environment-service.js";

const NOW = "2026-07-08T00:00:00.000Z";

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "", notFound: false };
}
function missing(): CommandResult {
  return { code: null, stdout: "", stderr: "", notFound: true };
}
function fail(stderr = ""): CommandResult {
  return { code: 1, stdout: "", stderr, notFound: false };
}

/** Build a CommandRunner from a map of `${command} ${args.join(' ')}` → result.
 *  Any command whose key is absent resolves to notFound. */
function runnerFrom(map: Record<string, CommandResult>): CommandRunner {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`.trim();
    return map[key] ?? map[command] ?? missing();
  };
}

/** A fully-healthy environment: every check ok. */
function healthyOptions(overrides: Partial<RunDoctorOptions> = {}): RunDoctorOptions {
  return {
    now: NOW,
    platform: "win32",
    osRelease: "10.0.22631",
    arch: "x64",
    nodeVersion: "v20.11.0",
    detectPowerBiDesktopVersion: async () => "2.155.756.0",
    runCommand: runnerFrom({
      "git --version": ok("git version 2.43.0"),
      "powerbi-desktop --version": ok("1.2.3"),
      "powerbi-desktop status": ok("connected: pbi-desktop-bridge-1234"),
      "powerbi-report-author --version": ok("1.0.0"),
      "fab-inspector --help": ok("Usage: fab-inspector ..."),
      "claude --version": ok("claude-code 1.0.0"),
      "claude auth status": ok("Logged in as consultant@example.com"),
      "copilot --version": ok("copilot 1.0.0"),
      "copilot auth status": ok("Signed in as octocat"),
    }),
    ...overrides,
  };
}

function checkById(report: Awaited<ReturnType<typeof runDoctorChecks>>, id: string) {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check with id ${id}`);
  return found;
}

describe("compareVersions", () => {
  it("orders dotted numeric versions segment by segment", () => {
    expect(compareVersions("2.155.756.0", "2.155.756.0")).toBe(0);
    expect(compareVersions("2.155.755.9", "2.155.756.0")).toBe(-1);
    expect(compareVersions("2.156.0.0", "2.155.756.0")).toBe(1);
    expect(compareVersions("2.155.756", "2.155.756.0")).toBe(0);
    expect(compareVersions("10.0.0", "9.999.999")).toBe(1);
  });
});

describe("runDoctorChecks classification matrix", () => {
  it("reports overall ok when every requirement is satisfied", async () => {
    const report = await runDoctorChecks(healthyOptions());
    expect(report.overall).toBe("ok");
    expect(report.generatedAt).toBe(NOW);
    for (const check of report.checks) {
      expect(check.status, `${check.id} should be ok`).toBe("ok");
    }
  });

  it("flags a non-Windows platform as a hard error", async () => {
    const report = await runDoctorChecks(healthyOptions({ platform: "darwin", arch: "arm64" }));
    const windows = checkById(report, "windows");
    expect(windows.status).toBe("error");
    expect(windows.hard).toBe(true);
    expect(report.overall).toBe("error");
  });

  it("flags a 32-bit Windows as a hard error", async () => {
    const report = await runDoctorChecks(healthyOptions({ arch: "ia32" }));
    expect(checkById(report, "windows").status).toBe("error");
    expect(report.overall).toBe("error");
  });

  it("flags Node below the minimum major as a hard error with an install command", async () => {
    const report = await runDoctorChecks(healthyOptions({ nodeVersion: "v18.19.0" }));
    const node = checkById(report, "node");
    expect(node.status).toBe("error");
    expect(node.detected).toBe("v18.19.0");
    expect(node.commands[0]?.command).toContain("winget install");
    expect(report.overall).toBe("error");
  });

  it("accepts Node at or above the minimum major", async () => {
    const report = await runDoctorChecks(healthyOptions({ nodeVersion: "v22.3.0" }));
    expect(checkById(report, "node").status).toBe("ok");
  });

  it("flags missing Git as a hard error", async () => {
    const report = await runDoctorChecks(
      healthyOptions({
        runCommand: runnerFrom({}), // every command not found
      }),
    );
    expect(checkById(report, "git").status).toBe("error");
    expect(report.overall).toBe("error");
  });

  it("warns (not errors) when Power BI Desktop is present but outdated", async () => {
    const report = await runDoctorChecks(
      healthyOptions({ detectPowerBiDesktopVersion: async () => "2.150.0.0" }),
    );
    const desktop = checkById(report, "powerbi-desktop");
    expect(desktop.status).toBe("warning");
    expect(desktop.detected).toBe("2.150.0.0");
    // A warning on a hard check keeps overall out of "error" but not "ok".
    expect(report.overall).toBe("warning");
  });

  it("errors when Power BI Desktop is not installed", async () => {
    const report = await runDoctorChecks(
      healthyOptions({ detectPowerBiDesktopVersion: async () => null }),
    );
    expect(checkById(report, "powerbi-desktop").status).toBe("error");
    expect(report.overall).toBe("error");
  });

  it("errors with an npm install command when the bridge CLI is missing", async () => {
    const report = await runDoctorChecks(
      healthyOptions({
        runCommand: runnerFrom({
          "git --version": ok("git version 2.43.0"),
          "powerbi-desktop status": ok("connected"),
          "powerbi-report-author --version": ok("1.0.0"),
          "fab-inspector --help": ok("Usage"),
          "claude --version": ok("1.0.0"),
          "claude auth status": ok("Logged in as x"),
          "copilot --version": ok("1.0.0"),
          "copilot auth status": ok("Signed in as y"),
          // powerbi-desktop --version intentionally absent → notFound
        }),
      }),
    );
    const cli = checkById(report, "desktop-bridge-cli");
    expect(cli.status).toBe("error");
    expect(cli.commands[0]?.command).toBe("npm install -g @microsoft/powerbi-desktop-bridge-cli");
  });

  it("warns with preview-feature remediation when the Desktop bridge is not connected", async () => {
    const report = await runDoctorChecks(
      healthyOptions({
        runCommand: runnerFrom({
          "git --version": ok("git version 2.43.0"),
          "powerbi-desktop --version": ok("1.2.3"),
          "powerbi-desktop status": ok("not_connected"),
          "powerbi-report-author --version": ok("1.0.0"),
          "fab-inspector --help": ok("Usage"),
          "claude --version": ok("1.0.0"),
          "claude auth status": ok("Logged in as x"),
          "copilot --version": ok("1.0.0"),
          "copilot auth status": ok("Signed in as y"),
        }),
      }),
    );
    const bridge = checkById(report, "desktop-bridge");
    expect(bridge.status).toBe("warning");
    expect(bridge.hard).toBe(false);
    expect(bridge.remediation).toMatch(/external tool access/i);
    // A soft warning does not drag overall to error.
    expect(report.overall).toBe("warning");
  });

  it("warns when an agent is installed but not signed in", async () => {
    const report = await runDoctorChecks(
      healthyOptions({
        runCommand: runnerFrom({
          "git --version": ok("git version 2.43.0"),
          "powerbi-desktop --version": ok("1.2.3"),
          "powerbi-desktop status": ok("connected"),
          "powerbi-report-author --version": ok("1.0.0"),
          "fab-inspector --help": ok("Usage"),
          "claude --version": ok("claude-code 1.0.0"),
          "claude auth status": fail("Not logged in. Run claude /login"),
          "copilot --version": ok("1.0.0"),
          "copilot auth status": ok("Signed in as octocat"),
        }),
      }),
    );
    const claude = checkById(report, "claude");
    expect(claude.status).toBe("warning");
    expect(claude.detected).toMatch(/not signed in/i);
    // copilot is signed in, so the aggregate agents check stays ok.
    expect(checkById(report, "agents").status).toBe("ok");
    expect(report.overall).toBe("warning");
  });

  it("errors the aggregate when no agent is installed or signed in", async () => {
    const report = await runDoctorChecks(
      healthyOptions({
        runCommand: runnerFrom({
          "git --version": ok("git version 2.43.0"),
          "powerbi-desktop --version": ok("1.2.3"),
          "powerbi-desktop status": ok("connected"),
          "powerbi-report-author --version": ok("1.0.0"),
          "fab-inspector --help": ok("Usage"),
          // no claude, no copilot
        }),
      }),
    );
    expect(checkById(report, "claude").status).toBe("warning");
    expect(checkById(report, "copilot").status).toBe("warning");
    const agents = checkById(report, "agents");
    expect(agents.status).toBe("error");
    expect(agents.hard).toBe(true);
    expect(report.overall).toBe("error");
  });
});
