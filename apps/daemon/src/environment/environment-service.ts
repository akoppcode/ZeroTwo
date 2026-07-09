import { spawn } from "node:child_process";
import { arch, release as osRelease } from "node:os";
import type {
  DoctorCheck,
  DoctorCheckId,
  DoctorOverallStatus,
  DoctorReport,
  DoctorStatus,
} from "@open-design/contracts";
import {
  DOCTOR_MINIMUM_NODE_MAJOR,
  DOCTOR_MINIMUM_POWERBI_DESKTOP_VERSION,
} from "@open-design/contracts";

/**
 * EnvironmentService — runs the Zero Two environment checks (spec §3.1/§3.3)
 * and produces a DoctorReport for GET /api/doctor, the Doctor screen, and the
 * setup.ps1/doctor.ps1 scripts. Every external probe goes through an injectable
 * `CommandRunner` and a set of injectable platform detectors so the whole matrix
 * is unit-testable against the fixtures/mock-bin fakes without touching PATH.
 */

export interface CommandResult {
  /** Process exit code, or null if it was killed / never spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the executable could not be found / spawned at all. */
  notFound: boolean;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface EnvironmentProbe {
  platform: NodeJS.Platform;
  osRelease: string;
  arch: string;
  nodeVersion: string;
  runCommand: CommandRunner;
  /** Returns the installed Power BI Desktop version (e.g. "2.155.756.0") or null
   *  if not installed. In production this reads the registry / PBIDesktop.exe
   *  file version; tests inject a fixed value. */
  detectPowerBiDesktopVersion: () => Promise<string | null>;
  /** Microsoft Store (MSIX) Power BI Desktop version, or null — used to flag the
   *  Store build (which the Desktop Bridge cannot drive) distinctly. */
  detectPowerBiDesktopStoreVersion: () => Promise<string | null>;
}

const AGENT_HARD = false;

/** Parse a dotted numeric version ("2.155.756.0") into comparable segments. */
function parseVersion(value: string): number[] | null {
  const match = value.match(/(\d+(?:\.\d+)+)/);
  const captured = match?.[1];
  if (!captured) return null;
  const parts = captured.split(".").map((segment) => Number.parseInt(segment, 10));
  return parts.every((n) => Number.isFinite(n)) ? parts : null;
}

/** Compare two dotted versions; returns -1/0/1 (a<b / a==b / a>b). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [];
  const pb = parseVersion(b) ?? [];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function check(
  id: DoctorCheckId,
  label: string,
  hard: boolean,
  status: DoctorStatus,
  detected: string | null,
  remediation: string | null,
  commands: DoctorCheck["commands"] = [],
): DoctorCheck {
  return { id, label, status, detected, remediation, commands, hard };
}

async function checkWindows(probe: EnvironmentProbe): Promise<DoctorCheck> {
  const is64 = probe.arch === "x64" || probe.arch === "arm64";
  if (probe.platform !== "win32") {
    return check(
      "windows",
      "Windows 10/11 (x64)",
      true,
      "error",
      `${probe.platform} ${probe.arch}`,
      "Zero Two runs on Windows 10/11 (x64) only.",
    );
  }
  if (!is64) {
    return check(
      "windows",
      "Windows 10/11 (x64)",
      true,
      "error",
      `Windows ${probe.arch}`,
      "A 64-bit build of Windows is required.",
    );
  }
  return check("windows", "Windows 10/11 (x64)", true, "ok", `Windows ${probe.osRelease} (${probe.arch})`, null);
}

async function checkNode(probe: EnvironmentProbe): Promise<DoctorCheck> {
  const version = probe.nodeVersion.replace(/^v/, "");
  const major = parseVersion(version)?.[0] ?? 0;
  if (major >= DOCTOR_MINIMUM_NODE_MAJOR) {
    return check("node", "Node.js", true, "ok", `v${version}`, null);
  }
  return check(
    "node",
    "Node.js",
    true,
    "error",
    `v${version}`,
    `Node.js ${DOCTOR_MINIMUM_NODE_MAJOR}+ is required.`,
    [{ label: "Install Node LTS", command: "winget install OpenJS.NodeJS.LTS" }],
  );
}

async function checkGit(probe: EnvironmentProbe): Promise<DoctorCheck> {
  const result = await probe.runCommand("git", ["--version"]);
  if (result.notFound || result.code !== 0) {
    return check("git", "Git", true, "error", null, "Git is required for the project safety net.", [
      { label: "Install Git", command: "winget install Git.Git" },
    ]);
  }
  const detected = result.stdout.trim() || "installed";
  return check("git", "Git", true, "ok", detected, null);
}

async function checkPowerBiDesktop(probe: EnvironmentProbe): Promise<DoctorCheck> {
  const version = await probe.detectPowerBiDesktopVersion();
  if (version == null) {
    // The Desktop Bridge can only drive the Download Center (MSI) build. If the
    // user has the Microsoft Store build, say so explicitly — otherwise Doctor
    // reads "not installed" for a machine that clearly has Power BI Desktop.
    const storeVersion = await probe.detectPowerBiDesktopStoreVersion();
    if (storeVersion != null) {
      return check(
        "powerbi-desktop",
        "Power BI Desktop",
        true,
        "error",
        `${storeVersion} (Microsoft Store)`,
        "You have the Microsoft Store version of Power BI Desktop, which the Desktop Bridge cannot launch. Install the Download Center (MSI) build instead: https://www.microsoft.com/download/details.aspx?id=58494 (or `winget install Microsoft.PowerBI`).",
      );
    }
    return check(
      "powerbi-desktop",
      "Power BI Desktop",
      true,
      "error",
      null,
      "Power BI Desktop is not installed. Install the Download Center (MSI) build: https://www.microsoft.com/download/details.aspx?id=58494 (the Microsoft Store build does not work with the Desktop Bridge).",
    );
  }
  if (compareVersions(version, DOCTOR_MINIMUM_POWERBI_DESKTOP_VERSION) < 0) {
    return check(
      "powerbi-desktop",
      "Power BI Desktop",
      true,
      "warning",
      version,
      `Power BI Desktop ${DOCTOR_MINIMUM_POWERBI_DESKTOP_VERSION}+ is required for the Desktop bridge. Update Power BI Desktop.`,
    );
  }
  return check("powerbi-desktop", "Power BI Desktop", true, "ok", version, null);
}

async function checkVersionedCli(
  probe: EnvironmentProbe,
  id: DoctorCheckId,
  label: string,
  command: string,
  installPackage: string,
): Promise<DoctorCheck> {
  const result = await probe.runCommand(command, ["--version"]);
  if (result.notFound || result.code !== 0) {
    return check(id, label, true, "error", null, `${label} is not installed.`, [
      { label: `Install ${label}`, command: `npm install -g ${installPackage}` },
    ]);
  }
  return check(id, label, true, "ok", result.stdout.trim() || "installed", null);
}

async function checkFabInspector(probe: EnvironmentProbe): Promise<DoctorCheck> {
  const result = await probe.runCommand("fab-inspector", ["--help"]);
  if (result.notFound || result.code !== 0) {
    return check(
      "fab-inspector",
      "Fab Inspector CLI",
      true,
      "error",
      null,
      "Fab Inspector (PBI Inspector V2) is not installed. Install it per its README and re-run setup.",
    );
  }
  return check("fab-inspector", "Fab Inspector CLI", true, "ok", "installed", null);
}

/** The Desktop bridge live check: `powerbi-desktop status`. `connected` is ok;
 *  `not_connected` is a soft warning with the preview-feature remediation. */
async function checkDesktopBridge(probe: EnvironmentProbe): Promise<DoctorCheck> {
  const result = await probe.runCommand("powerbi-desktop", ["status"]);
  if (result.notFound) {
    return check(
      "desktop-bridge",
      "Desktop bridge",
      false,
      "error",
      null,
      "The Desktop bridge CLI is not installed.",
    );
  }
  const out = `${result.stdout}${result.stderr}`.toLowerCase();
  if (out.includes("connected") && !out.includes("not_connected") && !out.includes("not connected")) {
    return check("desktop-bridge", "Desktop bridge", false, "ok", "connected", null);
  }
  return check(
    "desktop-bridge",
    "Desktop bridge",
    false,
    "warning",
    "not connected",
    'Open a report in Power BI Desktop and enable "Enable external tool access to Power BI Desktop through secure local APIs" (Options → Preview features), then re-check.',
  );
}

/** Agent CLI check: installed + logged in. `--version` proves install; a
 *  per-agent auth probe proves subscription login (spec §5.2 — never a key). */
async function checkAgent(
  probe: EnvironmentProbe,
  id: "claude" | "copilot",
  label: string,
  authArgs: string[],
): Promise<DoctorCheck> {
  const version = await probe.runCommand(id, ["--version"]);
  if (version.notFound || version.code !== 0) {
    return check(id, label, AGENT_HARD, "warning", null, `${label} is not installed.`);
  }
  const auth = await probe.runCommand(id, authArgs);
  const loggedIn = auth.code === 0 && !/not logged in|logged out|please (log|sign) in|unauthenticated/i.test(
    `${auth.stdout}${auth.stderr}`,
  );
  if (!loggedIn) {
    return check(
      id,
      label,
      AGENT_HARD,
      "warning",
      `${version.stdout.trim() || "installed"} (not signed in)`,
      `Sign in to ${label} with your subscription from Settings → Agents.`,
    );
  }
  const signedInAs = auth.stdout.trim();
  return check(id, label, AGENT_HARD, "ok", signedInAs || version.stdout.trim() || "signed in", null);
}

/** Derived requirement: at least one agent must be installed and signed in. */
function checkAgentsAggregate(claude: DoctorCheck, copilot: DoctorCheck): DoctorCheck {
  const anyOk = claude.status === "ok" || copilot.status === "ok";
  if (anyOk) {
    return check("agents", "At least one agent signed in", true, "ok", null, null);
  }
  return check(
    "agents",
    "At least one agent signed in",
    true,
    "error",
    null,
    "Sign in to Claude Code or GitHub Copilot CLI (subscription login) so Zero Two can drive an agent.",
  );
}

function overallStatus(checks: DoctorCheck[]): DoctorOverallStatus {
  if (checks.some((c) => c.hard && c.status === "error")) return "error";
  if (checks.some((c) => c.status === "warning" || c.status === "error")) return "warning";
  return "ok";
}

export interface RunDoctorOptions {
  runCommand?: CommandRunner;
  detectPowerBiDesktopVersion?: () => Promise<string | null>;
  detectPowerBiDesktopStoreVersion?: () => Promise<string | null>;
  platform?: NodeJS.Platform;
  osRelease?: string;
  arch?: string;
  nodeVersion?: string;
  /** ISO timestamp to stamp on the report (injected so the core stays pure). */
  now: string;
}

export async function runDoctorChecks(options: RunDoctorOptions): Promise<DoctorReport> {
  const probe: EnvironmentProbe = {
    platform: options.platform ?? process.platform,
    osRelease: options.osRelease ?? osRelease(),
    arch: options.arch ?? arch(),
    nodeVersion: options.nodeVersion ?? process.version,
    runCommand: options.runCommand ?? defaultCommandRunner,
    detectPowerBiDesktopVersion:
      options.detectPowerBiDesktopVersion ?? (async () => null),
    detectPowerBiDesktopStoreVersion:
      options.detectPowerBiDesktopStoreVersion ?? (async () => null),
  };

  const [windows, node, git, desktop, bridgeCli, reportCli, fabInspector, bridge, claude, copilot] =
    await Promise.all([
      checkWindows(probe),
      checkNode(probe),
      checkGit(probe),
      checkPowerBiDesktop(probe),
      checkVersionedCli(
        probe,
        "desktop-bridge-cli",
        "Power BI Desktop bridge CLI",
        "powerbi-desktop",
        "@microsoft/powerbi-desktop-bridge-cli",
      ),
      checkVersionedCli(
        probe,
        "report-authoring-cli",
        "Power BI report-authoring CLI",
        "powerbi-report-author",
        "@microsoft/powerbi-report-authoring-cli",
      ),
      checkFabInspector(probe),
      checkDesktopBridge(probe),
      checkAgent(probe, "claude", "Claude Code", ["auth", "status"]),
      checkAgent(probe, "copilot", "GitHub Copilot CLI", ["auth", "status"]),
    ]);

  const agents = checkAgentsAggregate(claude, copilot);
  const checks = [windows, node, git, desktop, bridgeCli, reportCli, fabInspector, bridge, claude, copilot, agents];
  return { overall: overallStatus(checks), checks, generatedAt: options.now };
}

/** Production runner: resolve on PATH and spawn, capturing output. */
export const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { shell: process.platform === "win32", windowsHide: true });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      finish({ code: null, stdout, stderr, notFound });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, notFound: false });
    });
  });
