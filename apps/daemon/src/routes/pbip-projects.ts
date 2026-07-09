import type { Express } from "express";
import type { RouteDeps } from "../server-context.js";
import { ProjectService, type ProjectAgent, type AttachOutcome } from "../pbip/project-service.js";
import { watchForPbip } from "../pbip/attach-watcher.js";

/**
 * Zero Two PBIP project routes (spec §4.4/§4.5/§12): attach an existing PBIP
 * folder or scaffold a new one, run inspection + the git baseline via
 * ProjectService, and persist the project row. Local-only. The chokidar
 * attach-wizard watcher (PBIX -> PBIP) layers on top of `attach`.
 */
export interface RegisterPbipProjectRoutesDeps extends RouteDeps<"db" | "http" | "ids"> {}

function isAgent(value: unknown): value is ProjectAgent {
  return value === "claude" || value === "copilot";
}

export function registerPbipProjectRoutes(app: Express, ctx: RegisterPbipProjectRoutesDeps) {
  const { db } = ctx;
  const { isLocalSameOrigin, resolvedPortRef, createSseResponse } = ctx.http;
  const { randomUUID } = ctx.ids;
  const service = new ProjectService();
  const getPort = () => resolvedPortRef.current;

  // List persisted Zero Two projects (attached/scaffolded PBIPs) for the Reports
  // home, newest first, so the user can return to earlier work.
  app.get("/api/projects/pbip", (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const rows = db
      .prepare(
        `SELECT id, name, kind, agent, pbip_path, metadata_json, created_at, updated_at
         FROM projects WHERE pbip_path IS NOT NULL ORDER BY updated_at DESC`,
      )
      .all() as Array<Record<string, any>>;
    const projects = rows.map((r) => {
      let meta: Record<string, any> = {};
      try {
        meta = JSON.parse(r.metadata_json ?? "{}");
      } catch {
        meta = {};
      }
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        agent: r.agent,
        path: r.pbip_path,
        pageCount: meta.pageCount ?? null,
        visualCount: meta.visualCount ?? null,
        hasSemanticModel: meta.hasSemanticModel ?? false,
        reportDirName: meta.reportDirName ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
    res.json({ projects });
  });

  const persist = (outcome: Extract<AttachOutcome, { ok: true }>): { id: string } => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO projects (id, name, kind, agent, pbip_path, metadata_json, created_at, updated_at)
       VALUES (@id, @name, @kind, @agent, @path, @metadata, @now, @now)`,
    ).run({
      id,
      name: outcome.project.name,
      kind: outcome.project.kind,
      agent: outcome.project.agent,
      path: outcome.project.path,
      metadata: JSON.stringify({
        pbipFile: outcome.project.pbipFile,
        reportDirName: outcome.project.reportDirName,
        hasSemanticModel: outcome.project.hasSemanticModel,
        semanticModelTmdl: outcome.project.semanticModelTmdl,
        pageCount: outcome.project.pageCount,
        visualCount: outcome.project.visualCount,
        baselineSha: outcome.project.baselineSha,
      }),
      now,
    });
    return { id };
  };

  const respond = (res: any, outcome: AttachOutcome) => {
    if (!outcome.ok) {
      return res.status(outcome.code === "no-report" ? 400 : 422).json({
        error: { code: outcome.code, message: outcome.message },
      });
    }
    const { id } = persist(outcome);
    res.status(201).json({
      project: { id, ...outcome.project },
      report: outcome.inspect.report,
    });
  };

  app.post("/api/projects/attach", async (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const path = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    const agent = req.body?.agent;
    if (!path) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "path is required" } });
    if (!isAgent(agent)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "agent must be claude or copilot" } });
    }
    try {
      respond(res, await service.attach(path, agent));
    } catch (err: any) {
      res.status(500).json({ error: { code: "ATTACH_FAILED", message: String(err?.message ?? err) } });
    }
  });

  app.post("/api/projects/scaffold", async (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const path = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const agent = req.body?.agent;
    if (!path || !name) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "path and name are required" } });
    }
    if (!isAgent(agent)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "agent must be claude or copilot" } });
    }
    try {
      respond(res, await service.scaffold(path, name, agent));
    } catch (err: any) {
      res.status(500).json({ error: { code: "SCAFFOLD_FAILED", message: String(err?.message ?? err) } });
    }
  });

  // Attach-wizard watch stream (spec §4.4, design §3.2 step 2). The renderer
  // opens this while the user does File → Save As → .pbip in Power BI Desktop.
  // We watch `destFolder`; when a valid PBIR project settles we attach + persist
  // and push it back over SSE so the wizard auto-advances. A legacy save surfaces
  // the enhanced-format guidance so the wizard can loop back. Closing the request
  // (cancelled wizard) aborts the watcher via the AbortController.
  app.post("/api/projects/attach/watch", (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const destFolder = typeof req.body?.destFolder === "string" ? req.body.destFolder.trim() : "";
    const agent = req.body?.agent;
    if (!destFolder) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "destFolder is required" } });
    }
    if (!isAgent(agent)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "agent must be claude or copilot" } });
    }

    const sse = createSseResponse(res);
    const controller = new AbortController();
    let seq = 0;
    const emit = (event: string, data: unknown) => sse.send(event, data, ++seq);
    res.on("close", () => controller.abort());

    emit("watching", { destFolder });
    void (async () => {
      try {
        const result = await watchForPbip(destFolder, { signal: controller.signal });
        if (result.status === "found") {
          const outcome = await service.attach(result.root, agent, "attached");
          if (outcome.ok) {
            const { id } = persist(outcome);
            emit("detected", { project: { id, ...outcome.project }, report: outcome.inspect.report });
            emit("done", {});
          } else {
            emit("error", { code: outcome.code, message: outcome.message });
          }
        } else if (result.status === "legacy") {
          emit("legacy", { message: result.message });
        } else {
          // "timeout" | "aborted"
          emit(result.status, {});
        }
      } catch (err: any) {
        emit("error", { message: String(err?.message ?? err) });
      } finally {
        sse.end();
      }
    })();
  });
}
