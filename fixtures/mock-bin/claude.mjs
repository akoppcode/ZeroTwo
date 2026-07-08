#!/usr/bin/env node
// Fake Claude Code CLI (command: claude). Subscription-login only — no API keys.
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.ZT_MOCK_CLAUDE_VERSION ?? "claude-code 1.0.0"}\n`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if ((process.env.ZT_MOCK_CLAUDE_LOGGED_IN ?? "1") === "1") {
    process.stdout.write(`Logged in as ${process.env.ZT_MOCK_CLAUDE_USER ?? "consultant@example.com"}\n`);
    process.exit(0);
  }
  process.stderr.write("Not logged in. Run: claude /login\n");
  process.exit(1);
}

process.stderr.write(`mock claude: unsupported command: ${args.join(" ")}\n`);
process.exit(1);
