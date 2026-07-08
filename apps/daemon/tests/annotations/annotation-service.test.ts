import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, closeDatabase } from "../../src/db.js";
import { AnnotationService } from "../../src/annotations/annotation-service.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures");

describe("AnnotationService", () => {
  let dir: string;
  let projectRoot: string;
  let svc: AnnotationService;
  const sessionId = "sess-1";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zt-annot-"));
    projectRoot = join(dir, "project");
    await cp(join(FIXTURES, "sample.pbip"), projectRoot, { recursive: true });
    const db = openDatabase(dir, { dataDir: join(dir, "data") });
    svc = new AnnotationService(db, () => randomUUID());
  });
  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a pin and hit-tests it to the containing visual", async () => {
    // card1 in the overview page is at x=40,y=40,w=300,h=120 → (60,60) is inside.
    const a = await svc.create(projectRoot, {
      sessionId,
      pageName: "overview",
      kind: "pin",
      x: 42,
      y: 42,
      canvasX: 60,
      canvasY: 60,
      text: "Move this KPI up",
    });
    expect(a).toMatchObject({ kind: "pin", status: "draft", visualId: "card1", matchKind: "contains" });
  });

  it("creates a rect and hit-tests by intersection", async () => {
    const a = await svc.create(projectRoot, {
      sessionId,
      pageName: "overview",
      kind: "rect",
      x: 40,
      y: 40,
      w: 300,
      h: 120,
      canvasX: 40,
      canvasY: 40,
      canvasW: 300,
      canvasH: 120,
      text: "cramped",
    });
    expect(a).toMatchObject({ kind: "rect", visualId: "card1", matchKind: "intersects" });
  });

  it("lists, edits text, and lets the user correct the matched visual", async () => {
    const a = await svc.create(projectRoot, {
      sessionId,
      pageName: "overview",
      kind: "pin",
      x: 42,
      y: 42,
      canvasX: 60,
      canvasY: 60,
    });
    expect(svc.list(sessionId)).toHaveLength(1);
    const updated = svc.update(a.id, { text: "align with cards", visualId: "chart1", visualType: "clusteredColumnChart" });
    expect(updated).toMatchObject({ text: "align with cards", visualId: "chart1", matchKind: "manual" });
  });

  it("submit synthesizes the §9.4 prompt per page and flips status to submitted, then resolved", async () => {
    await svc.create(projectRoot, {
      sessionId,
      pageName: "overview",
      kind: "pin",
      x: 42,
      y: 42,
      canvasX: 60,
      canvasY: 60,
      text: "Move this KPI up",
    });
    const blocks = await svc.submit(projectRoot, sessionId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.pageName).toBe("overview");
    expect(blocks[0]!.prompt).toContain('page "Overview" (page file: overview)');
    expect(blocks[0]!.prompt).toContain("Move this KPI up");
    expect(blocks[0]!.prompt).toContain("visual id=card1");

    expect(svc.list(sessionId).every((a) => a.status === "submitted")).toBe(true);
    svc.markResolved(sessionId);
    expect(svc.list(sessionId).every((a) => a.status === "resolved")).toBe(true);
    // A second submit with no drafts returns nothing.
    expect(await svc.submit(projectRoot, sessionId)).toHaveLength(0);
  });
});
