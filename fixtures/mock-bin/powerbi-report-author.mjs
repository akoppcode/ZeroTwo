#!/usr/bin/env node
// Fake @microsoft/powerbi-report-authoring-cli (command: powerbi-report-author).
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.ZT_MOCK_REPORT_AUTHOR_VERSION ?? "1.0.0"}\n`);
  process.exit(0);
}

if (args[0] === "validate") {
  if ((process.env.ZT_MOCK_REPORT_AUTHOR_VALIDATE ?? "ok") === "fail") {
    process.stderr.write("validation failed: 1 error\n");
    process.exit(1);
  }
  process.stdout.write("validation passed\n");
  process.exit(0);
}

process.stderr.write(`mock powerbi-report-author: unsupported command: ${args.join(" ")}\n`);
process.exit(1);
