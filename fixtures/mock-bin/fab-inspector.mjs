#!/usr/bin/env node
// Fake Fab Inspector (PBI Inspector V2) CLI (command: fab-inspector).
// Implements the V2 arg surface (-pbipreport / -rules / -output / -formats JSON)
// and deterministically evaluates Zero Two templated rules by inspecting the
// report on disk, so acceptance tests are real (e.g. max-visuals-per-page fails
// on the fat fixture, passes on the slim one). See ./README.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`Fab Inspector ${process.env.ZT_MOCK_FAB_INSPECTOR_VERSION ?? "2.0.0"}\n`);
  process.exit(0);
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const reportDir = argValue("-pbipreport");
const rulesFile = argValue("-rules");
const outDir = argValue("-output");

if (!reportDir || !rulesFile || !outDir) {
  process.stderr.write("mock fab-inspector: -pbipreport, -rules and -output are required\n");
  process.exit(1);
}

// Count visuals per page from the PBIR report on disk.
function visualsPerPage() {
  const pagesDir = join(reportDir, "definition", "pages");
  const counts = {};
  if (!existsSync(pagesDir)) return counts;
  for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const visualsDir = join(pagesDir, entry.name, "visuals");
    let n = 0;
    if (existsSync(visualsDir)) {
      n = readdirSync(visualsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    }
    counts[entry.name] = n;
  }
  return counts;
}

const rules = JSON.parse(readFileSync(rulesFile, "utf8")).rules ?? [];
const counts = visualsPerPage();

const results = rules.map((rule) => {
  if (rule.zerotwo?.check === "maxVisualsPerPage") {
    const max = rule.zerotwo.maxVisuals;
    const failingPages = Object.entries(counts)
      .filter(([, n]) => n > max)
      .map(([page, n]) => ({ page, visualCount: n, maxVisuals: max }));
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      logType: rule.logType ?? "warning",
      pass: failingPages.length === 0,
      failingPages,
    };
  }
  // Unknown/untemplated rules pass in the mock (real CLI evaluates the test).
  return { ruleId: rule.id, ruleName: rule.name, logType: rule.logType ?? "warning", pass: true, failingPages: [] };
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "results.json"), JSON.stringify({ results }, null, 2), "utf8");
process.stdout.write(`inspected ${rules.length} rule(s)\n`);
process.exit(0);
