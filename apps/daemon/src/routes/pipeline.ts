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

/**
 * Latest pipeline run per project, kept in memory so a run survives the UI
 * unmounting (view switch / navigation). The SSE handler still streams a fresh
 * run live; this snapshot lets the UI restore (and poll while `running`) after
 * it re-mounts. Only the newest run per project is retained (overwritten on a
 * new run).
 */
type PipelineRunState =
  | { status: "none" }
  | {
      runId: string;
      status: "running" | "done";
      ok?: boolean;
      stages: StageEvent[];
      screenshots?: { runId: string; pages: string[] };
      remediation?: { stage: string; message: string };
      startedAt: number;
      finishedAt?: number;
    };

function screenshotsRoot(projectPath: string): string {
  return join(projectPath, ".zerotwo", "screenshots");
}

export function registerPipelineRoutes(app: Express, ctx: RegisterPipelineRoutesDeps) {
  const { db } = ctx;
  const { isLocalSameOrigin, resolvedPortRef, createSseResponse } = ctx.http;
  const { randomUUID } = ctx.ids;
  const getPort = () => resolvedPortRef.current;

  // Latest run per project (see PipelineRunState). Lives for the daemon session.
  const latestRuns = new Map<string, Exclude<PipelineRunState, { status: "none" }>>();

  const loadProject = (id: string): { path: string; reportDir: string; openPath: string } | null => {
    const row = db.prepare(`SELECT pbip_path, metadata_json FROM projects WHERE id = ?`).get(id) as
      | ProjectRow
      | undefined;
    if (!row?.pbip_path) return null;
    let meta: Record<string, any> = {};
    try {
      meta = JSON.parse(row.metadata_json ?? "{}");
    } catch {
      meta = {};
    }
    const reportDirName = typeof meta.reportDirName === "string" ? meta.reportDirName : "";
    // What to open in Power BI Desktop: the .pbip pointer when present, else the
    // project folder (the bridge CLI resolves the report there).
    const openPath = typeof meta.pbipFile === "string" && meta.pbipFile ? join(row.pbip_path, meta.pbipFile) : row.pbip_path;
    return {
      path: row.pbip_path,
      reportDir: reportDirName ? join(row.pbip_path, reportDirName) : row.pbip_path,
      openPath,
    };
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

    // Track this as the project's latest run so the UI can restore/poll it after
    // the SSE client goes away (navigation / view switch). Writes to `state`
    // continue even after the client disconnects — the run is not tied to the SSE.
    const projectId = req.params.id;
    const state: Exclude<PipelineRunState, { status: "none" }> = {
      runId,
      status: "running",
      stages: [],
      startedAt: Date.now(),
    };
    latestRuns.set(projectId, state);

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
          openPath: project.openPath,
          // User-triggered preview: don't hard-stop on a report's pre-existing
          // validation issues; surface them but still reload + screenshot.
          blockOnValidate: false,
          onEvent: (event: StageEvent) => {
            state.stages.push(event);
            emit("pipeline:stage", event);
          },
          onScreenshots: (payload) => {
            state.screenshots = payload;
            emit("screenshots:updated", payload);
          },
        });
        state.status = "done";
        state.ok = result.ok;
        if (result.screenshots) state.screenshots = result.screenshots;
        if (result.remediation) state.remediation = result.remediation;
        state.finishedAt = Date.now();
        emit("pipeline:done", result);
      } catch (err: any) {
        state.status = "done";
        state.ok = false;
        state.finishedAt = Date.now();
        emit("pipeline:error", { message: String(err?.message ?? err) });
      } finally {
        sse.end();
      }
    })();
  });

  // Latest (in-progress or last-completed) run for a project, so the UI can
  // restore after unmounting and poll while `running`. Local-only.
  app.get("/api/projects/:id/pipeline/latest", (req, res) => {
    if (!isLocalSameOrigin(req, getPort())) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const state = latestRuns.get(req.params.id);
    res.json(state ?? ({ status: "none" } satisfies PipelineRunState));
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
