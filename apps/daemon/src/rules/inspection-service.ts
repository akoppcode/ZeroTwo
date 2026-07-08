import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuleSet } from "./rule-templates.js";

/**
 * InspectionService (spec §10.3) — runs the Fab Inspector CLI against a project's
 * *.Report folder with a ruleset, parses its JSON output into per-rule results,
 * and records a rule_runs row. Runner is injectable so tests drive the mock CLI.
 */

export interface FailingPage {
  page: string;
  visualCount?: number;
  maxVisuals?: number;
}

export interface RuleResult {
  ruleId: string;
  ruleName: string;
  logType: "warning" | "error";
  pass: boolean;
  failingPages: FailingPage[];
}

export interface InspectionRun {
  id: string;
  results: RuleResult[];
  passed: boolean;
}

export type CliRunner = (
  bin: string,
  argv: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: CliRunner = (bin, argv, opts) =>
  new Promise((resolve) => {
    execFile(bin, argv, { cwd: opts?.cwd, env: opts?.env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });

export interface InspectOptions {
  projectId?: string;
  sessionId?: string;
  bin?: string;
  runner?: CliRunner;
}

export class InspectionService {
  constructor(
    private readonly db: Database.Database,
    private readonly newId: () => string,
  ) {}

  async inspect(reportDir: string, ruleset: RuleSet, options: InspectOptions = {}): Promise<InspectionRun> {
    const runner = options.runner ?? defaultRunner;
    const bin = options.bin ?? "fab-inspector";
    const work = mkdtempSync(join(tmpdir(), "zt-inspect-"));
    const rulesFile = join(work, "rules.json");
    const outDir = join(work, "out");
    writeFileSync(rulesFile, JSON.stringify(ruleset), "utf8");

    try {
      const res = await runner(bin, ["-pbipreport", reportDir, "-rules", rulesFile, "-output", outDir, "-formats", "JSON"]);
      const resultsPath = join(outDir, "results.json");
      let results: RuleResult[] = [];
      if (existsSync(resultsPath)) {
        try {
          const parsed = JSON.parse(readFileSync(resultsPath, "utf8"));
          results = Array.isArray(parsed.results) ? parsed.results.map(normalizeResult) : [];
        } catch {
          results = [];
        }
      } else if (res.code !== 0) {
        throw new Error(`fab-inspector failed: ${res.stderr.trim() || res.stdout.trim()}`);
      }

      const id = this.newId();
      const rulesetHash = createHash("sha256").update(JSON.stringify(ruleset)).digest("hex").slice(0, 16);
      this.db
        .prepare(
          `INSERT INTO zerotwo_rule_runs (id, project_id, session_id, created_at, ruleset_hash, results_json)
           VALUES (@id, @project_id, @session_id, @now, @hash, @results)`,
        )
        .run({
          id,
          project_id: options.projectId ?? null,
          session_id: options.sessionId ?? null,
          now: Date.now(),
          hash: rulesetHash,
          results: JSON.stringify(results),
        });

      return { id, results, passed: results.every((r) => r.pass) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

function normalizeResult(r: any): RuleResult {
  return {
    ruleId: String(r.ruleId ?? r.id ?? ""),
    ruleName: String(r.ruleName ?? r.name ?? ""),
    logType: r.logType === "error" ? "error" : "warning",
    pass: r.pass === true,
    failingPages: Array.isArray(r.failingPages) ? r.failingPages : [],
  };
}
