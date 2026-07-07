import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAgentCliLogSources, buildRunEventLogSources } from "../src/agent-logs.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "diagnostics-agent-logs-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function touch(path: string, content = "x"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function touchAt(path: string, mtime: Date, content = "x"): Promise<void> {
  await touch(path, content);
  await utimes(path, mtime, mtime);
}

describe("buildRunEventLogSources", () => {
  it("returns [] when no runs dir", async () => {
    expect(await buildRunEventLogSources(null)).toEqual([]);
    expect(await buildRunEventLogSources(join(tempDir, "missing"))).toEqual([]);
  });

  it("collects the most-recent per-run events.jsonl, newest first", async () => {
    const runsDir = join(tempDir, "runs");
    await touchAt(join(runsDir, "run-a", "events.jsonl"), new Date("2026-01-01T00:00:00.000Z"), "a");
    await touchAt(join(runsDir, "run-b", "events.jsonl"), new Date("2026-01-02T00:00:00.000Z"), "b");
    // Directory without events.jsonl is skipped.
    await mkdir(join(runsDir, "run-empty"), { recursive: true });

    const sources = await buildRunEventLogSources(runsDir, { maxRuns: 5 });
    const names = sources.map((s) => s.name);
    expect(names).toEqual(["runs/run-b/events.jsonl", "runs/run-a/events.jsonl"]);
    for (const source of sources) {
      expect(source.kind).toBe("text");
      expect(source.tailBytes).toBeGreaterThan(0);
    }
  });

  it("caps the number of runs", async () => {
    const runsDir = join(tempDir, "runs");
    for (let i = 0; i < 5; i += 1) {
      await touchAt(join(runsDir, `run-${i}`, "events.jsonl"), new Date(2026, 0, i + 1), String(i));
    }
    const sources = await buildRunEventLogSources(runsDir, { maxRuns: 2 });
    expect(sources.map((source) => source.name)).toEqual([
      "runs/run-4/events.jsonl",
      "runs/run-3/events.jsonl",
    ]);
  });

  it("skips unsafe run directory names when collecting event logs", async () => {
    const runsDir = join(tempDir, "runs");
    await touch(join(runsDir, "safe-run_1.2", "events.jsonl"), "safe");
    await touch(join(runsDir, "unsafe run", "events.jsonl"), "space");
    // A colon is a legal separator on POSIX but an illegal filename char on
    // Windows (the CI platform), so only create that fixture off-Windows.
    if (process.platform !== "win32") {
      await touch(join(runsDir, "unsafe:run", "events.jsonl"), "colon");
    }

    const sources = await buildRunEventLogSources(runsDir, { maxRuns: 5 });
    expect(sources.map((source) => source.name)).toEqual([
      "runs/safe-run_1.2/events.jsonl",
    ]);
  });
});

describe("buildAgentCliLogSources", () => {
  it("collects claude log files under its known dir", async () => {
    // Zero Two drives only claude and copilot; log collection currently sweeps
    // the Claude Code log dir (subscription-only, no other agent CLIs bundled).
    const home = join(tempDir, "home");
    await touch(join(home, ".claude", "daemon.log"));
    // Secret-bearing files outside *.log dirs must NOT be swept.
    await touch(join(home, ".claude", "auth.json"), "secret");

    const sources = await buildAgentCliLogSources({ homeDir: home });
    const names = sources.map((s) => s.name);

    expect(names).toContain("agent-cli-logs/claude/daemon.log");
    // No secrets, and only *.log files.
    expect(names.some((n) => n.includes("auth.json"))).toBe(false);
    for (const source of sources) {
      expect(source.name.endsWith(".log")).toBe(true);
      expect(source.tailBytes).toBeGreaterThan(0);
    }
  });

  it("honors an explicit claudeConfigDir override over the home default", async () => {
    const home = join(tempDir, "home");
    const claudeDir = join(tempDir, "custom-claude");
    // The default home has a log that must be ignored when the override is set.
    await touch(join(home, ".claude", "daemon.log"));
    await touch(join(claudeDir, "cost-tracker.log"));

    const sources = await buildAgentCliLogSources({ homeDir: home, claudeConfigDir: claudeDir });
    const names = sources.map((s) => s.name);
    expect(names).toContain("agent-cli-logs/claude/cost-tracker.log");
    expect(names).not.toContain("agent-cli-logs/claude/daemon.log");
  });

  it("returns [] when homeDir is empty", async () => {
    expect(await buildAgentCliLogSources({ homeDir: "" })).toEqual([]);
  });
});
