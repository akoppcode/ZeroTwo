import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FabInspectorRule, RuleSet } from "./rule-templates.js";

/**
 * RuleStore (spec §10.1) — user rulesets live in `%APPDATA%/ZeroTwo/rules/` and
 * an optional per-project extension in `<project>/.zerotwo/rules/`. No rules ship
 * enabled. `mergeActive` produces the enabled ruleset the InspectionService runs
 * (project rules override user rules by id).
 */

export function defaultUserRulesDir(): string {
  const base = process.env.APPDATA ?? join(process.env.HOME ?? ".", ".config");
  return join(base, "ZeroTwo", "rules");
}

export interface RuleLintResult {
  ok: boolean;
  errors: string[];
}

export function lintRuleSet(raw: string): RuleLintResult {
  const errors: string[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${(err as Error).message}`] };
  }
  if (!parsed || !Array.isArray(parsed.rules)) {
    return { ok: false, errors: ["ruleset must be an object with a `rules` array"] };
  }
  parsed.rules.forEach((rule: any, i: number) => {
    for (const field of ["id", "name", "part", "test"]) {
      if (rule[field] == null) errors.push(`rules[${i}]: missing required field \`${field}\``);
    }
    if (rule.logType && rule.logType !== "warning" && rule.logType !== "error") {
      errors.push(`rules[${i}]: logType must be "warning" or "error"`);
    }
  });
  return { ok: errors.length === 0, errors };
}

export class RuleStore {
  constructor(private readonly userRulesDir: string = defaultUserRulesDir()) {}

  private ensureUserDir(): void {
    mkdirSync(this.userRulesDir, { recursive: true });
  }

  private projectRulesDir(projectRoot: string): string {
    return join(projectRoot, ".zerotwo", "rules");
  }

  listRulesets(): string[] {
    if (!existsSync(this.userRulesDir)) return [];
    return readdirSync(this.userRulesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }

  readRuleset(name: string): RuleSet | null {
    const path = join(this.userRulesDir, `${name}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  writeRuleset(name: string, ruleset: RuleSet): void {
    this.ensureUserDir();
    writeFileSync(join(this.userRulesDir, `${name}.json`), `${JSON.stringify(ruleset, null, 2)}\n`, "utf8");
  }

  private readProjectRules(projectRoot: string): FabInspectorRule[] {
    const dir = this.projectRulesDir(projectRoot);
    if (!existsSync(dir)) return [];
    const rules: FabInspectorRule[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const set = JSON.parse(readFileSync(join(dir, file), "utf8"));
        if (Array.isArray(set.rules)) rules.push(...set.rules);
      } catch {
        /* skip malformed project ruleset */
      }
    }
    return rules;
  }

  /** Merge the named user ruleset with the project's rules (project overrides by
   *  id), returning only enabled (non-disabled) rules. */
  mergeActive(projectRoot: string, rulesetName: string): RuleSet {
    const byId = new Map<string, FabInspectorRule>();
    for (const rule of this.readRuleset(rulesetName)?.rules ?? []) byId.set(rule.id, rule);
    for (const rule of this.readProjectRules(projectRoot)) byId.set(rule.id, rule);
    return { rules: [...byId.values()].filter((r) => !r.disabled) };
  }
}
