import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentInstructionFile,
  linkZeroTwoMd,
  writeZeroTwoMd,
  zeroTwoMarkdown,
} from "../../src/provisioning/zero-two-md.js";

describe("ZERO_TWO.md generation + linking", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zt-md-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("covers the four contract sections + the no-API-key rule", () => {
    const md = zeroTwoMarkdown();
    expect(md).toMatch(/## Iteration loop/);
    expect(md).toMatch(/## File-scope rule/);
    expect(md).toMatch(/## Comment-mode reply format/);
    expect(md).toMatch(/## Semantic-model work/);
    expect(md).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("writes ZERO_TWO.md into the project root", async () => {
    const path = await writeZeroTwoMd(dir);
    expect(path).toBe(join(dir, "ZERO_TWO.md"));
    expect(await readFile(path, "utf8")).toContain("Operating contract");
  });

  it("links from CLAUDE.md for claude and AGENTS.md for copilot", () => {
    expect(agentInstructionFile("claude")).toBe("CLAUDE.md");
    expect(agentInstructionFile("copilot")).toBe("AGENTS.md");
  });

  it("appends the link to an existing CLAUDE.md without clobbering it", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# My rules\nExisting content.\n", "utf8");
    await linkZeroTwoMd(dir, "claude");
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("# My rules");
    expect(content).toContain("Existing content.");
    expect(content).toMatch(/\[ZERO_TWO\.md\]\(\.\/ZERO_TWO\.md\)/);
  });

  it("creates AGENTS.md when absent and is idempotent", async () => {
    await linkZeroTwoMd(dir, "copilot");
    await linkZeroTwoMd(dir, "copilot");
    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    // The link block appears exactly once (its marked comment is the anchor).
    expect(content.match(/zero-two:link/g) ?? []).toHaveLength(1);
    expect(content).toMatch(/\[ZERO_TWO\.md\]\(\.\/ZERO_TWO\.md\)/);
  });
});
