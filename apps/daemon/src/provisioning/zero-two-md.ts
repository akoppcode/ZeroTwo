import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * ZERO_TWO.md generation + linking (spec §5.4). Zero Two writes a project-local
 * ZERO_TWO.md that tells the coding agent how to behave inside a Zero Two
 * session — the iteration loop, the file-scope rule, the comment-mode reply
 * format, and how to route semantic-model work — then links it from the agent's
 * own root instruction file (CLAUDE.md for Claude Code, AGENTS.md for Copilot)
 * so it is picked up automatically.
 */

export type ProvisioningAgent = "claude" | "copilot";

/** The agent's root instruction file that must reference ZERO_TWO.md. */
export function agentInstructionFile(agent: ProvisioningAgent): string {
  return agent === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

const LINK_MARKER = "<!-- zero-two:link -->";

export function zeroTwoMarkdown(): string {
  return `# ZERO_TWO.md

Operating contract for AI coding agents working in this Zero Two project.
Zero Two manages this Power BI report/model through you — follow this contract
every turn.

## Iteration loop
1. Read the request (a chat message, or comment-mode annotations pinned to
   specific pages/visuals).
2. Make the smallest change that satisfies it. Edit PBIP source directly
   (PBIR \`*.Report/definition/\`, TMDL \`*.SemanticModel/definition/\`).
3. State what you changed and why, in one short paragraph.
4. Zero Two commits the result to git after each accepted iteration — do not
   run git yourself.

## File-scope rule
Only edit files inside this project folder. Never touch \`.pbi/\` caches,
\`.pbix\` binaries, or anything under another project. Never create files
outside the report/model definitions unless explicitly asked.

## Comment-mode reply format
When the request carries pinned annotations, reply per annotation as:
\`- [<page> / <visual>] <what you changed>\`
so Zero Two can map each reply back to its pin.

## Semantic-model work
Route model changes (measures, columns, relationships, RLS) through the TMDL
files and the installed Power BI modeling skills — do not hand-edit the model
binary. Validate PBIR/TMDL with the installed validation skills before
declaring done.

## Auth
This is a subscription-authenticated session. Never ask for, read, or write
API keys (ANTHROPIC_API_KEY / OPENAI_API_KEY). Zero Two strips them from your
environment by design.
`;
}

/** Write ZERO_TWO.md into the project root. */
export async function writeZeroTwoMd(projectRoot: string): Promise<string> {
  const path = join(projectRoot, "ZERO_TWO.md");
  await writeFile(path, zeroTwoMarkdown(), "utf8");
  return path;
}

/** Ensure the agent's root instruction file links ZERO_TWO.md (idempotent).
 *  Appends a marked link block if absent; leaves existing content untouched. */
export async function linkZeroTwoMd(projectRoot: string, agent: ProvisioningAgent): Promise<string> {
  const file = agentInstructionFile(agent);
  const path = join(projectRoot, file);
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }
  if (existing.includes(LINK_MARKER)) return path;

  const block = `${LINK_MARKER}\n> This project is managed by **Zero Two**. Read and follow [ZERO_TWO.md](./ZERO_TWO.md) every turn.\n`;
  const next = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}` : block;
  await writeFile(path, next, "utf8");
  return path;
}
