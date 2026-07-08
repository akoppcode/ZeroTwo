#!/usr/bin/env node
// Fake Claude Code CLI (command: claude). Subscription-login only — no API keys.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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

// Plugin provisioning (non-interactive subcommands). State persists to
// ZT_MOCK_PLUGIN_STATE so `plugin list` reports what was installed.
if (args[0] === "plugin") {
  const statePath = process.env.ZT_MOCK_PLUGIN_STATE;
  const readState = () =>
    statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { marketplaces: [], plugins: [] };
  const writeState = (s) => statePath && writeFileSync(statePath, JSON.stringify(s), "utf8");
  const version = process.env.ZT_MOCK_PLUGIN_VERSION ?? "26.25";

  // Injected failure: ZT_MOCK_PLUGIN_FAIL is a substring of the failing command.
  const fail = process.env.ZT_MOCK_PLUGIN_FAIL;
  if (fail && args.join(" ").includes(fail)) {
    process.stderr.write(`mock claude: plugin step failed: ${args.join(" ")}\n`);
    process.exit(1);
  }

  if (args[1] === "marketplace" && args[2] === "add") {
    const state = readState();
    state.marketplaces.push(args[3]);
    writeState(state);
    process.stdout.write(`Added marketplace ${args[3]}\n`);
    process.exit(0);
  }
  if (args[1] === "install") {
    const state = readState();
    state.plugins.push({ ref: args[2], version });
    writeState(state);
    process.stdout.write(`Installed ${args[2]}\n`);
    process.exit(0);
  }
  if (args[1] === "list") {
    const state = readState();
    for (const p of state.plugins) process.stdout.write(`${p.ref}  v${p.version}\n`);
    process.exit(0);
  }
}

process.stderr.write(`mock claude: unsupported command: ${args.join(" ")}\n`);
process.exit(1);
