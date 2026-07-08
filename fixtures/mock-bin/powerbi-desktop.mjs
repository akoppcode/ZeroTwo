#!/usr/bin/env node
// Fake @microsoft/powerbi-desktop-bridge-cli (command: powerbi-desktop).
// Scenario via ZT_MOCK_PBID_* env. See ./README.md.
const args = process.argv.slice(2);
const cmd = args[0];

if (args.includes("--version")) {
  process.stdout.write(`${process.env.ZT_MOCK_PBID_VERSION ?? "1.2.3"}\n`);
  process.exit(0);
}

if (cmd === "status") {
  const status = process.env.ZT_MOCK_PBID_STATUS ?? "connected";
  if (status === "not_connected") {
    process.stdout.write("not_connected\n");
    process.exit(0);
  }
  process.stdout.write("connected: pbi-desktop-bridge-1234 (Report.pbip)\n");
  process.exit(0);
}

if (cmd === "manifest") {
  process.stdout.write(
    JSON.stringify({ methods: ["status", "open", "reload", "screenshot-all"] }) + "\n",
  );
  process.exit(0);
}

process.stderr.write(`mock powerbi-desktop: unsupported command: ${args.join(" ")}\n`);
process.exit(1);
