#!/usr/bin/env node
// Fake Fab Inspector (PBI Inspector V2) CLI (command: fab-inspector).
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    `Fab Inspector ${process.env.ZT_MOCK_FAB_INSPECTOR_VERSION ?? "2.0.0"}\n` +
      "Usage: fab-inspector <rules.json> <report-dir> [--output <path>]\n",
  );
  process.exit(0);
}

process.stderr.write(`mock fab-inspector: unsupported command: ${args.join(" ")}\n`);
process.exit(1);
