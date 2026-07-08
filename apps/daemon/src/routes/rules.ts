import type { Express } from "express";
import type { RouteDeps } from "../server-context.js";
import { RuleStore, lintRuleSet } from "../rules/rule-store.js";
import { InspectionService } from "../rules/inspection-service.js";
import { RULE_TEMPLATES, buildRuleFromTemplate, type RuleSet } from "../rules/rule-templates.js";

/**
 * Rules Studio routes (spec §10). Template gallery + ruleset CRUD (with lint) +
 * building a rule from a template + running an inspection against a project with
 * the merged active ruleset. Local-only.
 */
export interface RegisterRuleRoutesDeps extends RouteDeps<"db" | "http" | "ids"> {}

export function registerRuleRoutes(app: Express, ctx: RegisterRuleRoutesDeps) {
  const { db } = ctx;
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const getPort = () => resolvedPortRef.current;
  const store = new RuleStore();
  const inspection = new InspectionService(db, ctx.ids.randomUUID);

  const guard = (req: any, res: any): boolean => {
    if (!isLocalSameOrigin(req, getPort())) {
      res.status(403).json({ error: "cross-origin request rejected" });
      return false;
    }
    return true;
  };
  const projectRoot = (id: string): string | null => {
    const row = db.prepare(`SELECT pbip_path, metadata_json FROM projects WHERE id = ?`).get(id) as
      | { pbip_path: string | null; metadata_json: string | null }
      | undefined;
    return row?.pbip_path ?? null;
  };
  const reportDirOf = (id: string): string | null => {
    const row = db.prepare(`SELECT pbip_path, metadata_json FROM projects WHERE id = ?`).get(id) as
      | { pbip_path: string | null; metadata_json: string | null }
      | undefined;
    if (!row?.pbip_path) return null;
    let reportDirName = "";
    try {
      reportDirName = JSON.parse(row.metadata_json ?? "{}").reportDirName ?? "";
    } catch {
      /* ignore */
    }
    return reportDirName ? `${row.pbip_path}/${reportDirName}` : row.pbip_path;
  };

  app.get("/api/rules/templates", (req, res) => {
    if (!guard(req, res)) return;
    res.json({
      templates: RULE_TEMPLATES.map((t) => ({
        templateId: t.templateId,
        title: t.title,
        description: t.description,
        defaultSeverity: t.defaultSeverity,
      })),
    });
  });

  app.post("/api/rules/from-template", (req, res) => {
    if (!guard(req, res)) return;
    const { templateId, params } = req.body ?? {};
    const rule = buildRuleFromTemplate(String(templateId), params ?? {});
    if (!rule) return res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown template" } });
    res.json({ rule });
  });

  app.get("/api/rules/rulesets", (req, res) => {
    if (!guard(req, res)) return;
    res.json({ rulesets: store.listRulesets() });
  });

  app.get("/api/rules/rulesets/:name", (req, res) => {
    if (!guard(req, res)) return;
    const ruleset = store.readRuleset(req.params.name);
    if (!ruleset) return res.status(404).json({ error: { code: "NOT_FOUND", message: "ruleset not found" } });
    res.json({ ruleset });
  });

  app.put("/api/rules/rulesets/:name", (req, res) => {
    if (!guard(req, res)) return;
    const raw = JSON.stringify(req.body?.ruleset ?? {});
    const lint = lintRuleSet(raw);
    if (!lint.ok) return res.status(400).json({ error: { code: "INVALID_RULESET", message: "ruleset failed linting" }, lint });
    store.writeRuleset(req.params.name, req.body.ruleset as RuleSet);
    res.json({ ok: true });
  });

  app.post("/api/rules/lint", (req, res) => {
    if (!guard(req, res)) return;
    res.json(lintRuleSet(typeof req.body?.raw === "string" ? req.body.raw : JSON.stringify(req.body?.ruleset ?? {})));
  });

  app.post("/api/projects/:id/inspect", async (req, res) => {
    if (!guard(req, res)) return;
    const root = projectRoot(req.params.id);
    const reportDir = reportDirOf(req.params.id);
    if (!root || !reportDir) return res.status(404).json({ error: { code: "NOT_FOUND", message: "project not found" } });
    const rulesetName = typeof req.body?.rulesetName === "string" ? req.body.rulesetName : "default";
    const merged = store.mergeActive(root, rulesetName);
    if (merged.rules.length === 0) {
      return res.status(400).json({ error: { code: "NO_RULES", message: "no enabled rules in the active ruleset" } });
    }
    try {
      const run = await inspection.inspect(reportDir, merged, {
        projectId: req.params.id,
        sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
      });
      res.json(run);
    } catch (err: any) {
      res.status(500).json({ error: { code: "INSPECT_FAILED", message: String(err?.message ?? err) } });
    }
  });
}
