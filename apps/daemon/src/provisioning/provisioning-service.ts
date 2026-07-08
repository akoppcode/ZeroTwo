import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProvisioningPlan, expectedInstalledPlugins, type ProvisioningAgent } from "./provisioning-plan.js";
import { writeZeroTwoMd, linkZeroTwoMd } from "./zero-two-md.js";
import type { CliRunner } from "./auth-service.js";
import { execFile } from "node:child_process";

/**
 * ProvisioningService (spec §5.3). Drives the resolved command plan through the
 * agent CLI's non-interactive `plugin` subcommands, verifies the result against
 * `<cli> plugin list`, records the installed set to the project's zerotwo.json,
 * and writes + links ZERO_TWO.md. Never vendors the skills — installs from
 * source. Runner is injectable so tests drive the mock CLIs.
 */

export interface ProvisioningStepResult {
  command: string;
  ok: boolean;
  output: string;
}

export interface InstalledPlugin {
  ref: string;
  version: string;
}

export interface ProvisioningReport {
  agent: ProvisioningAgent;
  steps: ProvisioningStepResult[];
  installed: InstalledPlugin[];
  /** Expected plugins that never showed up in `plugin list`. */
  missing: string[];
  verified: boolean;
  zeroTwoMdPath: string;
}

const defaultRunner: CliRunner = (bin, argv, opts) =>
  new Promise((resolve) => {
    execFile(bin, argv, { cwd: opts?.cwd, env: opts?.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });

/** A `/plugin ...` REPL command → the non-interactive `plugin ...` argv. */
function stepArgv(command: string): string[] {
  return command.replace(/^\//, "").split(" ").filter(Boolean);
}

/** Parse `<cli> plugin list` lines of the form `ref  vVERSION`. */
export function parsePluginList(stdout: string): InstalledPlugin[] {
  const out: InstalledPlugin[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+v?(\S+)$/);
    if (m) out.push({ ref: m[1]!, version: m[2]! });
  }
  return out;
}

export interface ProvisionOptions {
  cwd: string;
  bin?: string;
  runner?: CliRunner;
  env?: NodeJS.ProcessEnv;
  onStep?: (result: ProvisioningStepResult) => void;
}

export class ProvisioningService {
  async provision(agent: ProvisioningAgent, opts: ProvisionOptions): Promise<ProvisioningReport> {
    const runner = opts.runner ?? defaultRunner;
    const bin = opts.bin ?? agent;
    const run = (argv: string[]) =>
      runner(bin, argv, opts.env ? { cwd: opts.cwd, env: opts.env } : { cwd: opts.cwd });

    const steps: ProvisioningStepResult[] = [];
    for (const step of buildProvisioningPlan(agent)) {
      const res = await run(stepArgv(step.command));
      const result: ProvisioningStepResult = {
        command: step.command,
        ok: res.code === 0,
        output: (res.stdout || res.stderr).trim(),
      };
      steps.push(result);
      opts.onStep?.(result);
    }

    // Verify against the CLI's own plugin list.
    const listRes = await run(["plugin", "list"]);
    const installed = parsePluginList(listRes.stdout);
    const installedRefs = new Set(installed.map((p) => p.ref));
    const expectedRefs = expectedInstalledPlugins().map((p) => `${p.plugin}@${p.marketplace}`);
    const missing = expectedRefs.filter((ref) => !installedRefs.has(ref));
    const verified = steps.every((s) => s.ok) && missing.length === 0;

    // Record the installed set to the project's zerotwo.json.
    const zeroDir = join(opts.cwd, ".zerotwo");
    await mkdir(zeroDir, { recursive: true });
    await writeFile(
      join(zeroDir, "zerotwo.json"),
      `${JSON.stringify({ agent, plugins: installed }, null, 2)}\n`,
      "utf8",
    );

    // Write + link the agent operating contract.
    const zeroTwoMdPath = await writeZeroTwoMd(opts.cwd);
    await linkZeroTwoMd(opts.cwd, agent);

    return { agent, steps, installed, missing, verified, zeroTwoMdPath };
  }
}
