import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * PBIP project inspection (spec §4.2). Given a project root, locate the report
 * (`*.Report`), classify its format (PBIR enhanced vs PBIR-legacy), and — for
 * PBIR — build the page/visual inventory plus semantic-model presence. All PBIR
 * parsing goes through this one module so field-name drift is fixture-locked
 * (spec §14 risk 5). Never throws on a malformed project: returns a structured
 * result the attach flow turns into UI guidance.
 */

export interface PbipVisual {
  /** Visual container name (the `visuals/<id>/` folder + visual.json `name`). */
  id: string;
  visualType: string | null;
  title: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  width: number | null;
  height: number | null;
}

export interface PbipPage {
  /** Page folder name (`definition/pages/<name>/`), the stable id. */
  name: string;
  displayName: string;
  hidden: boolean;
  width: number | null;
  height: number | null;
  visuals: PbipVisual[];
}

export interface PbipReport {
  /** Report folder name, e.g. "Sample.Report". */
  reportDirName: string;
  activePageName: string | null;
  pages: PbipPage[];
}

export interface PbipSemanticModel {
  dirName: string;
  /** True when the model is TMDL (`definition/` with `.tmdl` files). */
  tmdl: boolean;
}

export type PbipInspectResult =
  | {
      ok: true;
      /** The `.pbip` pointer file name. */
      pbipFile: string;
      report: PbipReport;
      semanticModel: PbipSemanticModel | null;
    }
  | {
      ok: false;
      /** Machine-readable reason so the wizard can branch. */
      code:
        | "no-pbip"
        | "no-report"
        | "pbir-legacy"
        | "unreadable";
      message: string;
    };

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
async function readJson(p: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function firstEntry(dir: string, predicate: (name: string) => boolean): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory() && predicate(e.name)) return e.name;
  } catch {
    /* ignore */
  }
  return null;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extract a visual's display title from the PBIR title object, if a literal. */
function extractTitle(visual: any): string | null {
  const titleObjs = visual?.visual?.visualContainerObjects?.title;
  const literal = titleObjs?.[0]?.properties?.text?.expr?.Literal?.Value;
  if (typeof literal !== "string") return null;
  // PBIR literal strings are wrapped in single quotes: 'Revenue Won'.
  return literal.replace(/^'(.*)'$/s, "$1");
}

async function parseVisual(visualDir: string): Promise<PbipVisual | null> {
  const json = await readJson(join(visualDir, "visual.json"));
  if (json == null) return null;
  const pos = json.position ?? {};
  return {
    id: typeof json.name === "string" ? json.name : basename(visualDir),
    visualType: typeof json.visual?.visualType === "string" ? json.visual.visualType : null,
    title: extractTitle(json),
    x: toNumber(pos.x),
    y: toNumber(pos.y),
    z: toNumber(pos.z),
    width: toNumber(pos.width),
    height: toNumber(pos.height),
  };
}

async function parsePage(pagesDir: string, pageName: string): Promise<PbipPage | null> {
  const pageDir = join(pagesDir, pageName);
  const pageJson = await readJson(join(pageDir, "page.json"));
  if (pageJson == null) return null;
  const visualsDir = join(pageDir, "visuals");
  const visuals: PbipVisual[] = [];
  try {
    const entries = await readdir(visualsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const v = await parseVisual(join(visualsDir, e.name));
      if (v) visuals.push(v);
    }
  } catch {
    /* a page may legitimately have no visuals */
  }
  visuals.sort((a, b) => a.id.localeCompare(b.id));
  const visibility = typeof pageJson.visibility === "string" ? pageJson.visibility : "";
  return {
    name: typeof pageJson.name === "string" ? pageJson.name : pageName,
    displayName: typeof pageJson.displayName === "string" ? pageJson.displayName : pageName,
    hidden: /hidden/i.test(visibility),
    width: toNumber(pageJson.width),
    height: toNumber(pageJson.height),
    visuals,
  };
}

async function inspectReport(reportDir: string, reportDirName: string): Promise<PbipReport> {
  const pagesDir = join(reportDir, "definition", "pages");
  const pagesMeta = await readJson(join(pagesDir, "pages.json"));
  const order: string[] = Array.isArray(pagesMeta?.pageOrder)
    ? pagesMeta.pageOrder.filter((n: unknown): n is string => typeof n === "string")
    : [];
  // Fall back to on-disk page folders when pages.json lacks an order.
  const onDisk = new Set<string>();
  try {
    for (const e of await readdir(pagesDir, { withFileTypes: true })) {
      if (e.isDirectory()) onDisk.add(e.name);
    }
  } catch {
    /* ignore */
  }
  const names = order.length > 0 ? order.filter((n) => onDisk.has(n)) : [...onDisk].sort();
  const pages: PbipPage[] = [];
  for (const name of names) {
    const page = await parsePage(pagesDir, name);
    if (page) pages.push(page);
  }
  return {
    reportDirName,
    activePageName: typeof pagesMeta?.activePageName === "string" ? pagesMeta.activePageName : null,
    pages,
  };
}

async function inspectSemanticModel(root: string): Promise<PbipSemanticModel | null> {
  const dirName = await firstEntry(root, (n) => n.endsWith(".SemanticModel"));
  if (!dirName) return null;
  const defDir = join(root, dirName, "definition");
  let tmdl = false;
  try {
    const stack = [defDir];
    while (stack.length > 0 && !tmdl) {
      const dir = stack.pop()!;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) stack.push(join(dir, e.name));
        else if (e.name.endsWith(".tmdl")) {
          tmdl = true;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { dirName, tmdl };
}

async function findPbipPointer(root: string): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const hit = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(".pbip"));
    return hit?.name ?? null;
  } catch {
    return null;
  }
}

export async function inspectPbip(root: string): Promise<PbipInspectResult> {
  const pbipFile = await findPbipPointer(root);
  if (!pbipFile) {
    return { ok: false, code: "no-pbip", message: "No .pbip pointer file found in this folder." };
  }

  const reportDirName = await firstEntry(root, (n) => n.endsWith(".Report"));
  if (!reportDirName) {
    return { ok: false, code: "no-report", message: "No *.Report folder found next to the .pbip file." };
  }
  const reportDir = join(root, reportDirName);

  const hasPbirDefinition = await isDir(join(reportDir, "definition"));
  const hasLegacyReportJson = await isFile(join(reportDir, "report.json"));
  if (!hasPbirDefinition) {
    if (hasLegacyReportJson) {
      return {
        ok: false,
        code: "pbir-legacy",
        message:
          "This report uses the legacy (PBIR-legacy) format. Open it in Power BI Desktop, enable the PBIR enhanced report format (Options → Preview features), and Save — Zero Two's tooling targets PBIR only.",
      };
    }
    return { ok: false, code: "unreadable", message: "The *.Report folder has no definition/ (PBIR) nor report.json." };
  }

  const report = await inspectReport(reportDir, reportDirName);
  const semanticModel = await inspectSemanticModel(root);
  return { ok: true, pbipFile, report, semanticModel };
}
