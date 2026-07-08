import type { PbipVisual } from "../pbip/pbip-inspect.js";

/**
 * Comment-mode geometry (spec §9.2/§9.3/§9.4): coordinate mapping, visual
 * hit-testing, and prompt synthesis. Pure functions over a page's visuals
 * (PbipVisual carries the id/position/type/title from PBIR). Validated against
 * a real report's visual boxes.
 */

export type MatchKind = "contains" | "intersects" | "nearest";

export interface AnnotationMatch {
  visualId: string | null;
  visualType: string | null;
  visualTitle: string | null;
  matchKind: MatchKind;
  /** For rects: fraction of the annotation rect covered by the visual (0..1). */
  intersectionFraction?: number;
}

function box(v: PbipVisual): { x: number; y: number; w: number; h: number } | null {
  if (v.x == null || v.y == null || v.width == null || v.height == null) return null;
  return { x: v.x, y: v.y, w: v.width, h: v.height };
}

function containsPoint(v: PbipVisual, px: number, py: number): boolean {
  const b = box(v);
  return !!b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

function intersectionArea(v: PbipVisual, r: { x: number; y: number; w: number; h: number }): number {
  const b = box(v);
  if (!b) return 0;
  const ix = Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x));
  const iy = Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
  return ix * iy;
}

function edgeDistance(v: PbipVisual, px: number, py: number): number {
  const b = box(v);
  if (!b) return Number.POSITIVE_INFINITY;
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
  return Math.hypot(dx, dy);
}

const zOf = (v: PbipVisual) => v.z ?? 0;

function toMatch(v: PbipVisual, kind: MatchKind, fraction?: number): AnnotationMatch {
  return {
    visualId: v.id,
    visualType: v.visualType,
    visualTitle: v.title,
    matchKind: kind,
    ...(fraction != null ? { intersectionFraction: fraction } : {}),
  };
}

/** Point pin: topmost (highest z) visual containing it, else nearest by edge. */
export function resolvePoint(visuals: PbipVisual[], px: number, py: number): AnnotationMatch | null {
  if (visuals.length === 0) return null;
  const hits = visuals.filter((v) => containsPoint(v, px, py)).sort((a, b) => zOf(b) - zOf(a));
  if (hits[0]) return toMatch(hits[0], "contains");
  const nearest = [...visuals].sort((a, b) => edgeDistance(a, px, py) - edgeDistance(b, px, py))[0]!;
  return toMatch(nearest, "nearest");
}

/** Rectangle: largest intersection area (as a fraction of the rect), else nearest. */
export function resolveRect(
  visuals: PbipVisual[],
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): AnnotationMatch | null {
  if (visuals.length === 0) return null;
  const rect = { x: rx, y: ry, w: rw, h: rh };
  const rectArea = Math.max(rw * rh, 1);
  const scored = visuals
    .map((v) => ({ v, area: intersectionArea(v, rect) }))
    .filter((s) => s.area > 0)
    .sort((a, b) => b.area - a.area || zOf(b.v) - zOf(a.v));
  if (scored[0]) return toMatch(scored[0].v, "intersects", scored[0].area / rectArea);
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const nearest = [...visuals].sort((a, b) => edgeDistance(a, cx, cy) - edgeDistance(b, cx, cy))[0]!;
  return toMatch(nearest, "nearest");
}

/** Screenshot pixel -> report canvas unit mapping (spec §9.2). */
export interface CanvasMapping {
  scale: number;
  aspectWarning: boolean;
}
export function screenshotToCanvasScale(
  pageWidthUnits: number,
  pageHeightUnits: number,
  screenshotWidthPx: number,
  screenshotHeightPx: number,
): CanvasMapping {
  const scale = pageWidthUnits / screenshotWidthPx;
  const expectedHeightPx = pageHeightUnits / scale;
  const aspectWarning = Math.abs(expectedHeightPx - screenshotHeightPx) / screenshotHeightPx > 0.02;
  return { scale, aspectWarning };
}
export const pxToCanvas = (px: number, scale: number): number => px * scale;

// ---- Prompt synthesis (spec §9.4 golden format) ----
export interface SynthAnnotation {
  kind: "pin" | "rect";
  x: number;
  y: number;
  w?: number;
  h?: number;
  text: string;
  match: AnnotationMatch;
}

export function synthesizePrompt(pageDisplayName: string, pageFile: string, annotations: SynthAnnotation[]): string {
  const lines: string[] = [];
  lines.push(`## Zero Two visual annotations — page "${pageDisplayName}" (page file: ${pageFile})`);
  lines.push("The user reviewed the latest rendered screenshot and left the following annotations.");
  lines.push("Coordinates are in report canvas units. Prefer targeting visuals by id.");
  lines.push("");
  annotations.forEach((a, i) => {
    const target =
      a.match.visualId != null
        ? `visual id=${a.match.visualId} type=${a.match.visualType ?? "?"} title="${a.match.visualTitle ?? ""}"`
        : "no matched visual";
    const matchNote =
      a.match.matchKind === "intersects" && a.match.intersectionFraction != null
        ? `intersects, ${Math.round(a.match.intersectionFraction * 100)}%`
        : a.match.matchKind;
    const head =
      a.kind === "pin"
        ? `[pin @ (x=${a.x}, y=${a.y})]`
        : `[rect (x=${a.x}, y=${a.y}, w=${a.w}, h=${a.h})]`;
    lines.push(`${i + 1}. ${head} -> ${target} (match: ${matchNote})`);
    lines.push(`   User: "${a.text}"`);
  });
  lines.push("");
  lines.push("Apply all changes, then run validation. Zero Two will re-render automatically.");
  return lines.join("\n");
}
