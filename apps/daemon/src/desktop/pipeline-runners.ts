import { execFile } from "node:child_process";
import type { StageOutput } from "./pipeline-service.js";

/**
 * Default stage runners for the pipeline (spec §6.2): structural validation via
 * the report-authoring CLI and policy inspection via fab-inspector. Kept
 * separate from PipelineService so tests inject fakes and the CLI binaries /
 * ruleset path are resolved here. Inspect is a no-op when no ruleset is active
 * (the Rules Studio, Phase 6, supplies one).
 */

export type CliRunner = (
  bin: string,
  argv: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: CliRunner = (bin, argv, opts) =>
  new Promise((resolve) => {
    execFile(bin, argv, { cwd: opts?.cwd, env: opts?.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });

export function makeValidateRunner(
  runner: CliRunner = defaultRunner,
  bin = "powerbi-report-author",
): (reportDir: string) => Promise<StageOutput> {
  return async (reportDir) => {
    const res = await runner(bin, ["validate", reportDir]);
    return { ok: res.code === 0, output: (res.stdout || res.stderr).trim() };
  };
}

export function makeInspectRunner(
  runner: CliRunner = defaultRunner,
  options: { bin?: string; rulesetPath?: string } = {},
): (reportDir: string) => Promise<StageOutput> {
  const bin = options.bin ?? "fab-inspector";
  return async (reportDir) => {
    if (!options.rulesetPath) {
      // No active ruleset — inspect is non-blocking and simply reports skipped.
      return { ok: true, output: "no active ruleset" };
    }
    const res = await runner(bin, [options.rulesetPath, reportDir]);
    return { ok: res.code === 0, output: (res.stdout || res.stderr).trim() };
  };
}
