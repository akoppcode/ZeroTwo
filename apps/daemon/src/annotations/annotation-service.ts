import type Database from "better-sqlite3";
import { inspectPbip, type PbipInspectResult, type PbipPage } from "../pbip/pbip-inspect.js";
import {
  resolvePoint,
  resolveRect,
  synthesizePrompt,
  type AnnotationMatch,
  type SynthAnnotation,
} from "./annotation-resolve.js";

/**
 * AnnotationService (spec §9) — persists comment-mode annotations, hit-tests
 * them against the page's PBIR visuals, and synthesizes the §9.4 batch prompt on
 * submit. Lifecycle: draft → submitted → resolved. Coordinates are stored in both
 * screenshot px (x/y/w/h) and report canvas units (canvas_*); hit-testing uses
 * canvas units.
 */

export type AnnotationKind = "pin" | "rect";
export type AnnotationStatus = "draft" | "submitted" | "resolved";

export interface Annotation {
  id: string;
  sessionId: string;
  pageName: string;
  kind: AnnotationKind;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  canvasX: number | null;
  canvasY: number | null;
  canvasW: number | null;
  canvasH: number | null;
  text: string;
  visualId: string | null;
  visualType: string | null;
  visualTitle: string | null;
  matchKind: string | null;
  status: AnnotationStatus;
}

export interface CreateAnnotationInput {
  sessionId: string;
  pageName: string;
  kind: AnnotationKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  canvasX: number;
  canvasY: number;
  canvasW?: number;
  canvasH?: number;
  text?: string;
}

type Row = Record<string, any>;

function rowToAnnotation(r: Row): Annotation {
  return {
    id: r.id,
    sessionId: r.session_id,
    pageName: r.page_name,
    kind: r.kind,
    x: r.x,
    y: r.y,
    w: r.w ?? null,
    h: r.h ?? null,
    canvasX: r.canvas_x ?? null,
    canvasY: r.canvas_y ?? null,
    canvasW: r.canvas_w ?? null,
    canvasH: r.canvas_h ?? null,
    text: r.text ?? "",
    visualId: r.visual_id ?? null,
    visualType: r.visual_type ?? null,
    visualTitle: r.visual_title ?? null,
    matchKind: r.match_kind ?? null,
    status: r.status,
  };
}

export type InspectFn = (root: string) => Promise<PbipInspectResult>;

export class AnnotationService {
  constructor(
    private readonly db: Database.Database,
    private readonly newId: () => string,
    private readonly inspect: InspectFn = inspectPbip,
  ) {}

  private async loadPage(projectRoot: string, pageName: string): Promise<PbipPage | null> {
    const result = await this.inspect(projectRoot);
    if (!result.ok) return null;
    return result.report.pages.find((p) => p.name === pageName) ?? null;
  }

  /** Hit-test canvas coordinates against a page's visuals (spec §9.3). */
  async resolve(projectRoot: string, input: CreateAnnotationInput): Promise<AnnotationMatch | null> {
    const page = await this.loadPage(projectRoot, input.pageName);
    if (!page) return null;
    if (input.kind === "rect" && input.canvasW != null && input.canvasH != null) {
      return resolveRect(page.visuals, input.canvasX, input.canvasY, input.canvasW, input.canvasH);
    }
    return resolvePoint(page.visuals, input.canvasX, input.canvasY);
  }

  /** Create an annotation, hit-testing it against the page's visuals. */
  async create(projectRoot: string, input: CreateAnnotationInput): Promise<Annotation> {
    const match = await this.resolve(projectRoot, input);
    const id = this.newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO zerotwo_annotations
         (id, session_id, page_name, kind, x, y, w, h, canvas_x, canvas_y, canvas_w, canvas_h,
          text, visual_id, visual_type, visual_title, match_kind, status, created_at, updated_at)
         VALUES (@id, @session_id, @page_name, @kind, @x, @y, @w, @h, @canvas_x, @canvas_y, @canvas_w, @canvas_h,
          @text, @visual_id, @visual_type, @visual_title, @match_kind, 'draft', @now, @now)`,
      )
      .run({
        id,
        session_id: input.sessionId,
        page_name: input.pageName,
        kind: input.kind,
        x: input.x,
        y: input.y,
        w: input.w ?? null,
        h: input.h ?? null,
        canvas_x: input.canvasX,
        canvas_y: input.canvasY,
        canvas_w: input.canvasW ?? null,
        canvas_h: input.canvasH ?? null,
        text: input.text ?? "",
        visual_id: match?.visualId ?? null,
        visual_type: match?.visualType ?? null,
        visual_title: match?.visualTitle ?? null,
        match_kind: match?.matchKind ?? null,
        now,
      });
    return this.get(id)!;
  }

  get(id: string): Annotation | null {
    const row = this.db.prepare(`SELECT * FROM zerotwo_annotations WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToAnnotation(row) : null;
  }

  list(sessionId: string): Annotation[] {
    const rows = this.db
      .prepare(`SELECT * FROM zerotwo_annotations WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as Row[];
    return rows.map(rowToAnnotation);
  }

  /** Edit the text or manually correct the matched visual (§9.3 dropdown). */
  update(id: string, patch: { text?: string; visualId?: string; visualType?: string; visualTitle?: string }): Annotation | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE zerotwo_annotations
         SET text = @text, visual_id = @visual_id, visual_type = @visual_type, visual_title = @visual_title,
             match_kind = CASE WHEN @override = 1 THEN 'manual' ELSE match_kind END, updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id,
        text: patch.text ?? existing.text,
        visual_id: patch.visualId ?? existing.visualId,
        visual_type: patch.visualType ?? existing.visualType,
        visual_title: patch.visualTitle ?? existing.visualTitle,
        override: patch.visualId ? 1 : 0,
        now: Date.now(),
      });
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM zerotwo_annotations WHERE id = ?`).run(id);
  }

  /**
   * Flip the session's draft annotations to submitted and synthesize the §9.4
   * prompt block per page. Returns one block per page that had drafts.
   */
  async submit(projectRoot: string, sessionId: string): Promise<{ pageName: string; prompt: string }[]> {
    const drafts = this.list(sessionId).filter((a) => a.status === "draft");
    if (drafts.length === 0) return [];

    const byPage = new Map<string, Annotation[]>();
    for (const a of drafts) {
      const list = byPage.get(a.pageName) ?? [];
      list.push(a);
      byPage.set(a.pageName, list);
    }

    const result = await this.inspect(projectRoot);
    const pageDisplay = (name: string): string =>
      (result.ok ? result.report.pages.find((p) => p.name === name)?.displayName : undefined) ?? name;

    const blocks: { pageName: string; prompt: string }[] = [];
    for (const [pageName, list] of byPage) {
      const synth: SynthAnnotation[] = list.map((a) => ({
        kind: a.kind,
        x: Math.round(a.canvasX ?? a.x),
        y: Math.round(a.canvasY ?? a.y),
        ...(a.kind === "rect" ? { w: Math.round(a.canvasW ?? a.w ?? 0), h: Math.round(a.canvasH ?? a.h ?? 0) } : {}),
        text: a.text,
        match: {
          visualId: a.visualId,
          visualType: a.visualType,
          visualTitle: a.visualTitle,
          matchKind: (a.matchKind as AnnotationMatch["matchKind"]) ?? "nearest",
        },
      }));
      blocks.push({ pageName, prompt: synthesizePrompt(pageDisplay(pageName), pageName, synth) });
    }

    const now = Date.now();
    const ids = drafts.map((a) => a.id);
    const stmt = this.db.prepare(`UPDATE zerotwo_annotations SET status = 'submitted', updated_at = ? WHERE id = ?`);
    const tx = this.db.transaction((rows: string[]) => rows.forEach((id) => stmt.run(now, id)));
    tx(ids);

    return blocks;
  }

  /** After the next screenshot run, submitted annotations become resolved markers. */
  markResolved(sessionId: string): void {
    this.db
      .prepare(`UPDATE zerotwo_annotations SET status = 'resolved', updated_at = ? WHERE session_id = ? AND status = 'submitted'`)
      .run(Date.now(), sessionId);
  }
}
