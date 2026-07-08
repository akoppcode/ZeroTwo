import { describe, expect, it } from "vitest";
import type { PbipVisual } from "../../src/pbip/pbip-inspect.js";
import {
  resolvePoint,
  resolveRect,
  screenshotToCanvasScale,
  pxToCanvas,
  synthesizePrompt,
} from "../../src/annotations/annotation-resolve.js";

const V = (id: string, x: number, y: number, w: number, h: number, z = 0, visualType = "card", title = ""): PbipVisual => ({
  id,
  visualType,
  title,
  x,
  y,
  z,
  width: w,
  height: h,
});

describe("resolvePoint", () => {
  const visuals = [V("a", 0, 0, 100, 100, 1), V("b", 0, 0, 100, 100, 5), V("c", 300, 300, 50, 50)];
  it("returns the topmost (highest z) containing visual", () => {
    expect(resolvePoint(visuals, 50, 50)).toMatchObject({ visualId: "b", matchKind: "contains" });
  });
  it("falls back to nearest by edge distance when nothing contains the point", () => {
    expect(resolvePoint(visuals, 320, 100)).toMatchObject({ visualId: "c", matchKind: "nearest" });
  });
  it("returns null with no visuals", () => {
    expect(resolvePoint([], 1, 1)).toBeNull();
  });
});

describe("resolveRect", () => {
  const visuals = [V("small", 0, 0, 40, 40), V("big", 0, 0, 200, 200)];
  it("orders by intersection area (largest wins) and reports the fraction", () => {
    const m = resolveRect(visuals, 0, 0, 100, 100);
    expect(m).toMatchObject({ visualId: "big", matchKind: "intersects" });
    expect(m?.intersectionFraction).toBeCloseTo(1, 5);
  });
  it("falls back to nearest when the rect misses everything", () => {
    expect(resolveRect(visuals, 500, 500, 10, 10)).toMatchObject({ matchKind: "nearest" });
  });
});

describe("screenshotToCanvasScale", () => {
  it("computes uniform scale and flags aspect mismatch", () => {
    const ok = screenshotToCanvasScale(1280, 720, 1600, 900);
    expect(ok.scale).toBeCloseTo(0.8, 5);
    expect(ok.aspectWarning).toBe(false);
    expect(pxToCanvas(100, ok.scale)).toBeCloseTo(80, 5);
    expect(screenshotToCanvasScale(1280, 720, 1600, 700).aspectWarning).toBe(true);
  });
});

describe("synthesizePrompt (golden §9.4)", () => {
  it("renders the exact batch block", () => {
    const prompt = synthesizePrompt("Overview", "overview", [
      {
        kind: "pin",
        x: 612,
        y: 88,
        text: "Move this KPI up so it aligns with the others",
        match: { visualId: "g1", visualType: "cardVisual", visualTitle: "Revenue Won", matchKind: "contains" },
      },
      {
        kind: "rect",
        x: 40,
        y: 400,
        w: 520,
        h: 180,
        text: "This table is too cramped, give it more breathing room and larger row height",
        match: { visualId: "g2", visualType: "tableEx", visualTitle: "Opportunities", matchKind: "intersects", intersectionFraction: 0.92 },
      },
    ]);
    expect(prompt).toBe(
      [
        '## Zero Two visual annotations — page "Overview" (page file: overview)',
        "The user reviewed the latest rendered screenshot and left the following annotations.",
        "Coordinates are in report canvas units. Prefer targeting visuals by id.",
        "",
        '1. [pin @ (x=612, y=88)] -> visual id=g1 type=cardVisual title="Revenue Won" (match: contains)',
        '   User: "Move this KPI up so it aligns with the others"',
        '2. [rect (x=40, y=400, w=520, h=180)] -> visual id=g2 type=tableEx title="Opportunities" (match: intersects, 92%)',
        '   User: "This table is too cramped, give it more breathing room and larger row height"',
        "",
        "Apply all changes, then run validation. Zero Two will re-render automatically.",
      ].join("\n"),
    );
  });
});
