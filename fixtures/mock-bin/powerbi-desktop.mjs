#!/usr/bin/env node
// Fake @microsoft/powerbi-desktop-bridge-cli (command: powerbi-desktop).
// Scenario via ZT_MOCK_PBID_* env. See ./README.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (args.includes("--version")) {
  process.stdout.write(`${process.env.ZT_MOCK_PBID_VERSION ?? "1.2.3"}\n`);
  process.exit(0);
}

if (cmd === "status") {
  const status = process.env.ZT_MOCK_PBID_STATUS ?? "connected";
  if (status === "not_connected") {
    // Match the real bridge: not_connected is JSON, not plain text.
    process.stdout.write(JSON.stringify({ status: "not_connected", instances: [] }) + "\n");
    process.exit(0);
  }
  // ZT_MOCK_PBID_INSTANCES: "PID:title;PID:title" for the PID-ambiguity picker.
  const instances = process.env.ZT_MOCK_PBID_INSTANCES ?? "1234:Report.pbip";
  const list = instances
    .split(";")
    .filter(Boolean)
    .map((entry) => {
      const [pid, title = "Report.pbip"] = entry.split(":");
      return { pid: Number(pid), title };
    });
  process.stdout.write(JSON.stringify({ status: "connected", instances: list }) + "\n");
  process.exit(0);
}

if (cmd === "manifest") {
  const methods = (process.env.ZT_MOCK_PBID_METHODS ?? "status,open,reload,screenshot-all,manifest").split(",");
  process.stdout.write(JSON.stringify({ methods }) + "\n");
  process.exit(0);
}

if (cmd === "open") {
  process.stdout.write(`opened ${args[1] ?? ""}\n`);
  process.exit(0);
}

if (cmd === "reload") {
  if ((process.env.ZT_MOCK_PBID_RELOAD ?? "ok") === "fail") {
    process.stderr.write("reload failed: bridge not connected\n");
    process.exit(1);
  }
  process.stdout.write("reloaded\n");
  process.exit(0);
}

if (cmd === "screenshot-all") {
  const outDir = argValue("--output-dir");
  if (!outDir) {
    process.stderr.write("screenshot-all: --out <dir> is required\n");
    process.exit(1);
  }
  if ((process.env.ZT_MOCK_PBID_SCREENSHOT ?? "ok") === "fail") {
    process.stderr.write("screenshot failed: Desktop window not found\n");
    process.exit(1);
  }
  // 1x1 transparent PNG bytes.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const pageIds = (process.env.ZT_MOCK_PBID_PAGES ?? "overview,details").split(",").filter(Boolean);
  mkdirSync(outDir, { recursive: true });
  // Match the real bridge: files are named by DISPLAY NAME (distinct from the
  // page id), returned under `screenshots` with pageId/pageDisplayName/outputPath.
  const screenshots = pageIds.map((pageId) => {
    const pageDisplayName = pageId.charAt(0).toUpperCase() + pageId.slice(1);
    const outputPath = join(outDir, `${pageDisplayName}.png`);
    writeFileSync(outputPath, png);
    return { pageId, pageDisplayName, outputPath };
  });
  process.stdout.write(JSON.stringify({ status: "ok", screenshots, failures: [] }) + "\n");
  process.exit(0);
}

process.stderr.write(`mock powerbi-desktop: unsupported command: ${args.join(" ")}\n`);
process.exit(1);
