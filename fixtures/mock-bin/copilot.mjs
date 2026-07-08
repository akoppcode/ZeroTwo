#!/usr/bin/env node
// Fake GitHub Copilot CLI (command: copilot). Subscription-login only — no keys.
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.ZT_MOCK_COPILOT_VERSION ?? "copilot 1.0.0"}\n`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if ((process.env.ZT_MOCK_COPILOT_LOGGED_IN ?? "1") === "1") {
    process.stdout.write(`Signed in as ${process.env.ZT_MOCK_COPILOT_USER ?? "octocat"}\n`);
    process.exit(0);
  }
  process.stderr.write("Not logged in. Run: copilot auth login\n");
  process.exit(1);
}

process.stderr.write(`mock copilot: unsupported command: ${args.join(" ")}\n`);
process.exit(1);
