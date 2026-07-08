import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { inspectPbip } from "../../src/pbip/pbip-inspect.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures");
const SAMPLE = join(FIXTURES, "sample.pbip");
const LEGACY = join(FIXTURES, "legacy-sample.pbip");

describe("inspectPbip — PBIR sample fixture", () => {
  it("classifies the PBIR project and returns the pointer + report + model", async () => {
    const result = await inspectPbip(SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pbipFile).toBe("Sample.pbip");
    expect(result.report.reportDirName).toBe("Sample.Report");
    expect(result.semanticModel).toMatchObject({ dirName: "Sample.SemanticModel", tmdl: true });
  });

  it("returns pages in pageOrder with display names, hidden flags, and the active page", async () => {
    const result = await inspectPbip(SAMPLE);
    if (!result.ok) throw new Error("expected ok");
    expect(result.report.activePageName).toBe("overview");
    expect(result.report.pages.map((p) => p.name)).toEqual(["overview", "details"]);
    const [overview, details] = result.report.pages;
    expect(overview).toMatchObject({ displayName: "Overview", hidden: false, width: 1280, height: 720 });
    expect(details).toMatchObject({ displayName: "Details", hidden: true });
  });

  it("builds the per-page visual inventory with type, title, and position", async () => {
    const result = await inspectPbip(SAMPLE);
    if (!result.ok) throw new Error("expected ok");
    const overview = result.report.pages.find((p) => p.name === "overview")!;
    expect(overview.visuals.map((v) => v.id).sort()).toEqual(["card1", "card2", "chart1", "slicer1"]);
    const card1 = overview.visuals.find((v) => v.id === "card1")!;
    expect(card1).toMatchObject({
      visualType: "card",
      title: "Revenue Won",
      x: 40,
      y: 40,
      width: 300,
      height: 120,
    });
    const chart = overview.visuals.find((v) => v.id === "chart1")!;
    expect(chart.visualType).toBe("clusteredColumnChart");
    const details = result.report.pages.find((p) => p.name === "details")!;
    expect(details.visuals.map((v) => v.visualType).sort()).toEqual(["card", "tableEx"]);
  });

  it("counts the whole fixture inventory (2 pages, 6 visuals)", async () => {
    const result = await inspectPbip(SAMPLE);
    if (!result.ok) throw new Error("expected ok");
    expect(result.report.pages).toHaveLength(2);
    expect(result.report.pages.reduce((n, p) => n + p.visuals.length, 0)).toBe(6);
  });
});

describe("inspectPbip — rejection paths", () => {
  it("rejects a legacy (PBIR-legacy) report with actionable guidance", async () => {
    const result = await inspectPbip(LEGACY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pbir-legacy");
    expect(result.message).toMatch(/enhanced report format/i);
  });

  it("rejects a folder with no *.Report (not a Power BI project)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zt-noreport-"));
    await writeFile(join(dir, "Orphan.pbip"), "{}", "utf8");
    const result = await inspectPbip(dir);
    expect(result).toMatchObject({ ok: false, code: "no-report" });
  });
});

describe("inspectPbip — optional .pbip pointer", () => {
  it("accepts a PBIR project that has no .pbip pointer (real exports omit it)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zt-nopointer-"));
    const dest = join(dir, "copy");
    await cp(SAMPLE, dest, { recursive: true });
    await rm(join(dest, "Sample.pbip"));
    const result = await inspectPbip(dest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pbipFile).toBeNull();
    expect(result.report.pages).toHaveLength(2);
  });
});
