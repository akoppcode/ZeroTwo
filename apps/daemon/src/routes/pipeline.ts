import type { Express } from "express";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { RouteDeps } from "../server-context.js";
import { DesktopService } from "../desktop/desktop-service.js";
import { PipelineService, type StageEvent } from "../desktop/pipeline-service.js";
import { makeValidateRunner, makeInspectRunner } from "../desktop/pipeline-runners.js";
import { GitService } from "../git/git-service.js";

/**
 * Pipeline routes (spec §6.2, §7). POST runs the post-turn loop for a project
 * and streams stage events over SSE; GET serves a captured screenshot. Local-
 * only. Project path + report dir come from the persisted project row.
 */
export interface RegisterPipelineRoutesDeps extends RouteDeps<"db" | "http" | "ids"> {}

interface ProjectRow {
  pbip_path: string | null;
  metadata_json: string | null;
}

function screenshotsRoot(projectPath: string): string {
  return join(projectPath, ".zerotwo", "screenshots");
}

export function registerPipelineRoutes(app: Express, ctx: RegisterPipelineRoutesDeps) {
  const { db } = ctx;
  const { isLocalSameOrigin, resolvedPortRef, createSseResponse } = ctx.http;
  const { randomUUID } = ctx.ids;
  const getPort = () => resolvedPortRef.current;

  const loadProject = (id: string): { path: string; reportDir: string } | null => {
    const row = db.prepare(`SELECT pbip_path, metadata_json FROM projects WHERE id = ?`).get(id) as
      | ProjectRow
      | undefined;
    if (!row?.pbip_path) return null;
    let reportDirName = "";
    try {
      reportDirName = JSON.parse(row.metadata_json ?? "{}").reportDirName ?? "";
    } catch {
      reportDirName = "";
    }
    return { path: row.pbip_path, reportDir: reportDirName ? join(row.pbip_path, reportDirName) : row.pbip_path };
  };

  app.post("/api/projects/:id/pipeline/run", (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const project = loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: "NOT_FOUND", message: "project not found" } });

    const runId = randomUUID();
    const runDir = join(screenshotsRoot(project.path), runId);
    const reloadWithModel = req.body?.reloadWithModel === true;

    const pipeline = new PipelineService({
      validate: makeValidateRunner(),
      inspect: makeInspectRunner(),
      desktop: new DesktopService(),
      git: new GitService(),
    });

    const sse = createSseResponse(res);
    let seq = 0;
    const emit = (event: string, data: unknown) => sse.send(event, data, ++seq);

    emit("pipeline:start", { runId });
    void (async () => {
      try {
        const result = await pipeline.run({
          runId,
          projectRoot: project.path,
          reportDir: project.reportDir,
          runDir,
          agentSummary: typeof req.body?.summary === "string" ? req.body.summary : "chore: pipeline run",
          reloadWithModel,
          onEvent: (event: StageEvent) => emit("pipeline:stage", event),
          onScreenshots: (payload) => emit("screenshots:updated", payload),
        });
        emit("pipeline:done", result);
      } catch (err: any) {
        emit("pipeline:error", { message: String(err?.message ?? err) });
      } finally {
        sse.end();
      }
    })();
  });

  // Serve a captured screenshot (spec §7). Page name is sanitized and the
  // resolved path is confined to the project's screenshots dir.
  app.get("/api/projects/:id/screenshots/:runId/:page", (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const project = loadProject(req.params.id);
    if (!project) return res.status(404).end();

    const page = basename(req.params.page).replace(/[^A-Za-z0-9._-]/g, "");
    const runId = basename(req.params.runId).replace(/[^A-Za-z0-9._-]/g, "");
    const file = page.endsWith(".png") ? page : `${page}.png`;
    const root = resolve(screenshotsRoot(project.path));
    const target = resolve(join(root, runId, file));
    if (!target.startsWith(root) || !existsSync(target)) return res.status(404).end();
    res.type("png").sendFile(target);
  });
}
