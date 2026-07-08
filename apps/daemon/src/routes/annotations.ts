import type { Express } from "express";
import type { RouteDeps } from "../server-context.js";
import { AnnotationService, type AnnotationKind } from "../annotations/annotation-service.js";

/**
 * Comment-mode annotation routes (spec §9). CRUD over a session's annotations
 * (each hit-tested against the project's PBIR visuals on create) plus submit,
 * which flips drafts to submitted and returns the §9.4 prompt block(s) for the
 * renderer to send into the active session. Local-only.
 */
export interface RegisterAnnotationRoutesDeps extends RouteDeps<"db" | "http" | "ids"> {}

export function registerAnnotationRoutes(app: Express, ctx: RegisterAnnotationRoutesDeps) {
  const { db } = ctx;
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const getPort = () => resolvedPortRef.current;
  const service = new AnnotationService(db, ctx.ids.randomUUID);

  const guard = (req: any, res: any): boolean => {
    if (!isLocalSameOrigin(req, getPort())) {
      res.status(403).json({ error: "cross-origin request rejected" });
      return false;
    }
    return true;
  };

  const projectRoot = (id: string): string | null => {
    const row = db.prepare(`SELECT pbip_path FROM projects WHERE id = ?`).get(id) as { pbip_path: string | null } | undefined;
    return row?.pbip_path ?? null;
  };

  app.post("/api/projects/:id/annotations", async (req, res) => {
    if (!guard(req, res)) return;
    const root = projectRoot(req.params.id);
    if (!root) return res.status(404).json({ error: { code: "NOT_FOUND", message: "project not found" } });
    const b = req.body ?? {};
    const kind: AnnotationKind = b.kind === "rect" ? "rect" : "pin";
    if (typeof b.sessionId !== "string" || typeof b.pageName !== "string") {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "sessionId and pageName are required" } });
    }
    if (typeof b.canvasX !== "number" || typeof b.canvasY !== "number") {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "canvasX and canvasY are required" } });
    }
    try {
      const annotation = await service.create(root, {
        sessionId: b.sessionId,
        pageName: b.pageName,
        kind,
        x: Number(b.x ?? 0),
        y: Number(b.y ?? 0),
        w: b.w != null ? Number(b.w) : undefined,
        h: b.h != null ? Number(b.h) : undefined,
        canvasX: Number(b.canvasX),
        canvasY: Number(b.canvasY),
        canvasW: b.canvasW != null ? Number(b.canvasW) : undefined,
        canvasH: b.canvasH != null ? Number(b.canvasH) : undefined,
        text: typeof b.text === "string" ? b.text : "",
      });
      res.status(201).json({ annotation });
    } catch (err: any) {
      res.status(500).json({ error: { code: "ANNOTATION_FAILED", message: String(err?.message ?? err) } });
    }
  });

  app.get("/api/annotations", (req, res) => {
    if (!guard(req, res)) return;
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    if (!sessionId) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "sessionId is required" } });
    res.json({ annotations: service.list(sessionId) });
  });

  app.patch("/api/annotations/:aid", (req, res) => {
    if (!guard(req, res)) return;
    const b = req.body ?? {};
    const updated = service.update(req.params.aid, {
      text: typeof b.text === "string" ? b.text : undefined,
      visualId: typeof b.visualId === "string" ? b.visualId : undefined,
      visualType: typeof b.visualType === "string" ? b.visualType : undefined,
      visualTitle: typeof b.visualTitle === "string" ? b.visualTitle : undefined,
    });
    if (!updated) return res.status(404).json({ error: { code: "NOT_FOUND", message: "annotation not found" } });
    res.json({ annotation: updated });
  });

  app.delete("/api/annotations/:aid", (req, res) => {
    if (!guard(req, res)) return;
    service.delete(req.params.aid);
    res.status(204).end();
  });

  app.post("/api/projects/:id/annotations/submit", async (req, res) => {
    if (!guard(req, res)) return;
    const root = projectRoot(req.params.id);
    if (!root) return res.status(404).json({ error: { code: "NOT_FOUND", message: "project not found" } });
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    if (!sessionId) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "sessionId is required" } });
    try {
      const blocks = await service.submit(root, sessionId);
      res.json({ blocks });
    } catch (err: any) {
      res.status(500).json({ error: { code: "SUBMIT_FAILED", message: String(err?.message ?? err) } });
    }
  });
}
