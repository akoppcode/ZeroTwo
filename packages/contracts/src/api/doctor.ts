/**
 * Doctor / environment-check contract shared by the daemon (EnvironmentService,
 * GET /api/doctor) and the renderer (Doctor screen). See spec §3.1/§3.3/§3.7.
 */

/** Per-check outcome. `warning` is a soft problem (e.g. outdated Desktop, agent
 *  not signed in) that doesn't block the app; `error` is a hard failure. */
export type DoctorStatus = "ok" | "warning" | "error" | "unknown";

/** Stable ids for each environment requirement (spec §3.1). */
export type DoctorCheckId =
  | "windows"
  | "node"
  | "git"
  | "powerbi-desktop"
  | "desktop-bridge-cli"
  | "desktop-bridge"
  | "report-authoring-cli"
  | "fab-inspector"
  | "claude"
  | "copilot"
  | "agents";

export interface DoctorRemediationCommand {
  /** Human label for the action, e.g. "Install the bridge CLI". */
  label: string;
  /** Copyable shell command, e.g. "npm install -g @microsoft/powerbi-desktop-bridge-cli". */
  command: string;
}

export interface DoctorCheck {
  id: DoctorCheckId;
  /** Display name, e.g. "Power BI Desktop". */
  label: string;
  status: DoctorStatus;
  /** Detected value shown next to the row (version, "connected", "signed in as …"), or null. */
  detected: string | null;
  /** Prose remediation shown when status is not ok, or null. */
  remediation: string | null;
  /** Copyable commands that resolve the problem, or empty. */
  commands: DoctorRemediationCommand[];
  /** Hard requirement: a non-ok hard check makes the overall report an error and
   *  fails setup.ps1/doctor.ps1 with a non-zero exit. */
  hard: boolean;
}

export type DoctorOverallStatus = "ok" | "warning" | "error";

export interface DoctorReport {
  /** Worst status across hard checks (error if any hard check errors; warning if
   *  any check warns; otherwise ok). */
  overall: DoctorOverallStatus;
  checks: DoctorCheck[];
  /** ISO timestamp stamped by the caller when the report was produced. */
  generatedAt: string;
}

export const DOCTOR_MINIMUM_POWERBI_DESKTOP_VERSION = "2.155.756.0" as const;
export const DOCTOR_MINIMUM_NODE_MAJOR = 20 as const;
