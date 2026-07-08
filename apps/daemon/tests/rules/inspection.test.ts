import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, closeDatabase } from "../../src/db.js";
import { InspectionService, type CliRunner } from "../../src/rules/inspection-service.js";
import { RuleStore, lintRuleSet } from "../../src/rules/rule-store.js";
import { buildRuleFromTemplate, RULE_TEMPLATES, type RuleSet } from "../../src/rules/rule-templates.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures");
const MOCK_BIN = join(FIXTURES, "mock-bin");

function mockRunner(): CliRunner {
  return (bin, argv, opts) =>
    new Promise((resolve) => {
      const mock = join(MOCK_BIN, `${bin}.mjs`);
      execFile(process.execPath, [mock, ...argv], { cwd: opts?.cwd, env: { ...process.env, ...opts?.env } }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      });
    });
}

const maxVisualsRuleset = (max: number): RuleSet => ({ rules: [buildRuleFromTemplate("max-visuals-per-page", { maxVisuals: max })!] });

describe("InspectionService (mock fab-inspector) — max visuals per page", () => {
  let dir: string;
  let svc: InspectionService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zt-rules-"));
    const db = openDatabase(dir, { dataDir: join(dir, "data") });
    svc = new InspectionService(db, () => randomUUID());
  });
  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it("fails on the fat fixture (15 visuals) with maxVisuals=10", async () => {
    const reportDir = join(FIXTURES, "fat-sample.pbip", "Fat.Report");
    const run = await svc.inspect(reportDir, maxVisualsRuleset(10), { runner: mockRunner(), projectId: "p1" });
    expect(run.passed).toBe(false);
    const rule = run.results[0]!;
    expect(rule.pass).toBe(false);
    expect(rule.failingPages[0]).toMatchObject({ page: "dense", visualCount: 15, maxVisuals: 10 });
  });

  it("passes on the slim fixture (overview has 4 visuals) with maxVisuals=10", async () => {
    const reportDir = join(FIXTURES, "sample.pbip", "Sample.Report");
    const run = await svc.inspect(reportDir, maxVisualsRuleset(10), { runner: mockRunner(), projectId: "p1" });
    expect(run.passed).toBe(true);
    expect(run.results[0]!.pass).toBe(true);
  });

  it("records a rule_runs row", async () => {
    const reportDir = join(FIXTURES, "sample.pbip", "Sample.Report");
    const run = await svc.inspect(reportDir, maxVisualsRuleset(10), { runner: mockRunner() });
    expect(run.id).toBeTruthy();
  });
});

describe("RuleStore", () => {
  let userDir: string;
  let projectRoot: string;
  let store: RuleStore;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), "zt-store-"));
    userDir = join(base, "user-rules");
    projectRoot = join(base, "project");
    await mkdir(projectRoot, { recursive: true });
    store = new RuleStore(userDir);
  });

  it("writes + lists + reads a ruleset", () => {
    store.writeRuleset("default", maxVisualsRuleset(10));
    expect(store.listRulesets()).toEqual(["default"]);
    expect(store.readRuleset("default")?.rules[0]?.id).toBe("MAX_VISUALS_PER_PAGE_10");
  });

  it("merges project rules over user rules by id and drops disabled", async () => {
    store.writeRuleset("default", { rules: [buildRuleFromTemplate("max-visuals-per-page", { maxVisuals: 10 })!] });
    const projectRulesDir = join(projectRoot, ".zerotwo", "rules");
    await mkdir(projectRulesDir, { recursive: true });
    // Project overrides the same id with maxVisuals=5, plus a disabled rule.
    await writeFile(
      join(projectRulesDir, "override.json"),
      JSON.stringify({ rules: [{ ...buildRuleFromTemplate("max-visuals-per-page", { maxVisuals: 5 })!, id: "MAX_VISUALS_PER_PAGE_10" }, { id: "OFF", name: "off", part: "Page", test: [], disabled: true }] }),
      "utf8",
    );
    const merged = store.mergeActive(projectRoot, "default");
    expect(merged.rules).toHaveLength(1);
    expect(merged.rules[0]!.zerotwo?.maxVisuals).toBe(5); // project override won
  });

  it("lints a ruleset for JSON + required fields", () => {
    expect(lintRuleSet("{ not json").ok).toBe(false);
    expect(lintRuleSet(JSON.stringify({ rules: [{ name: "x" }] })).errors.join()).toMatch(/missing required field/);
    expect(lintRuleSet(JSON.stringify(maxVisualsRuleset(10))).ok).toBe(true);
  });
});

describe("rule templates", () => {
  it("exposes the gallery and none are shipped enabled by default (created on demand)", () => {
    expect(RULE_TEMPLATES.map((t) => t.templateId)).toContain("max-visuals-per-page");
    const rule = buildRuleFromTemplate("max-visuals-per-page", { maxVisuals: 8 });
    expect(rule).toMatchObject({ part: "Page", zerotwo: { check: "maxVisualsPerPage", maxVisuals: 8 } });
  });
});
