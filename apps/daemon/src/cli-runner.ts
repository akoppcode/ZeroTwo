import { execFile } from "node:child_process";

/**
 * Windows-safe external CLI runner. The Power BI + agent CLIs (powerbi-report-
 * author, fab-inspector, powerbi-desktop, claude, copilot) install as `.cmd`
 * shims on Windows. `execFile(bin, argsArray)` without a shell ENOENTs on a
 * `.cmd`, and naive shell use splits arguments containing spaces — which every
 * real report path does (e.g. `OneDrive - Orkla\...\Aggregated Report`). So on
 * Windows we build a single quoted command line and run it through the shell;
 * elsewhere the argv array is passed directly (no shell, no quoting needed).
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (
  bin: string,
  argv: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CliResult>;

const MAX_BUFFER = 64 * 1024 * 1024;

/** Quote an argument for cmd.exe when it contains whitespace or shell metachars. */
function quoteWindowsArg(value: string): string {
  return /[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const runCli: CliRunner = (bin, argv, opts) =>
  new Promise((resolve) => {
    const onDone = (err: unknown, stdout: string | Buffer, stderr: string | Buffer): void => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    };
    const base = {
      cwd: opts?.cwd,
      env: opts?.env,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
    } as const;

    if (process.platform === "win32") {
      const commandLine = [bin, ...argv].map(quoteWindowsArg).join(" ");
      execFile(commandLine, { ...base, shell: true }, onDone);
    } else {
      execFile(bin, argv, base, onDone);
    }
  });
