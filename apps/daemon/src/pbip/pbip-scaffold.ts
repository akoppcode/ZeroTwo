import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Write a minimal, valid PBIR-format PBIP into `root` (spec §4.5): a `.pbip`
 * pointer, a `*.Report/definition/` with report.json + version.json + one empty
 * page, and an empty TMDL `*.SemanticModel` the model workflows fill in later.
 *
 * The embedded shape mirrors the committed `fixtures/sample.pbip`. Per spec §4.5
 * the authoritative template should be generated once from a real Power BI
 * Desktop blank-report Save-As and committed; until then this is the structural
 * scaffold, and `powerbi-report-author validate` is a Windows manual-check item.
 */

const PBIR_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition";

function sanitizeArtifactName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 _-]+/g, "").trim();
  return cleaned.length > 0 ? cleaned : "Report";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface ScaffoldResult {
  pbipFile: string;
  reportDirName: string;
  semanticModelDirName: string;
}

export async function scaffoldPbip(root: string, reportName: string): Promise<ScaffoldResult> {
  const name = sanitizeArtifactName(reportName);
  const reportDir = `${name}.Report`;
  const modelDir = `${name}.SemanticModel`;
  const pbipFile = `${name}.pbip`;

  await mkdir(root, { recursive: true });

  await writeJson(join(root, pbipFile), {
    version: "1.0",
    artifacts: [{ report: { path: reportDir } }],
    settings: { enableAutoRecovery: true },
  });

  // Report (PBIR enhanced format).
  await writeJson(join(root, reportDir, "definition.pbir"), {
    version: "4.0",
    datasetReference: { byPath: { path: `../${modelDir}` } },
  });
  await writeJson(join(root, reportDir, "definition", "version.json"), { version: "4.0" });
  await writeJson(join(root, reportDir, "definition", "report.json"), {
    $schema: `${PBIR_SCHEMA}/report/1.0.0/schema.json`,
    themeCollection: { baseTheme: { name: "CY24SU10" } },
    layoutOptimization: "None",
  });
  await writeJson(join(root, reportDir, "definition", "pages", "pages.json"), {
    $schema: `${PBIR_SCHEMA}/pagesMetadata/1.0.0/schema.json`,
    pageOrder: ["page1"],
    activePageName: "page1",
  });
  await writeJson(join(root, reportDir, "definition", "pages", "page1", "page.json"), {
    $schema: `${PBIR_SCHEMA}/page/1.0.0/schema.json`,
    name: "page1",
    displayName: "Page 1",
    displayOption: "FitToPage",
    width: 1280,
    height: 720,
  });

  // Empty semantic model (TMDL) — the model builder fills it in (§8).
  await writeJson(join(root, modelDir, "definition.pbism"), { version: "4.0", settings: {} });
  await mkdir(join(root, modelDir, "definition"), { recursive: true });
  await writeFile(
    join(root, modelDir, "definition", "database.tmdl"),
    "database\n\tcompatibilityLevel: 1567\n",
    "utf8",
  );
  await writeFile(
    join(root, modelDir, "definition", "model.tmdl"),
    "model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n",
    "utf8",
  );

  return { pbipFile, reportDirName: reportDir, semanticModelDirName: modelDir };
}
