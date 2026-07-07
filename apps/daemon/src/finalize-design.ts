// Synthesis primitives for finalizing a project's design intent into a
// `DESIGN.md` artifact: resolve the project's "current artifact" (active
// artifact tab, fallback to newest .artifact.json by manifest.updatedAt,
// fallback null), build the synthesis prompt from the transcript + design
// system + artifact, and truncate the exported transcript so it fits an
// LLM context window.
//
// The BYOK direct-provider call path (Anthropic/OpenAI/Azure/Google/Ollama
// over HTTP with a caller-supplied API key) was removed along with the
// `/api/projects/:id/finalize/:provider` route — the product is
// subscription-login only via local CLI agents.

import fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  listFiles,
  readProjectFile,
  reconcileHtmlArtifactManifest,
  resolveProjectDir,
  validateProjectPath,
} from './projects.js';

const INPUT_BODY_CAP_BYTES = 384 * 1024;

type Db = Database.Database;

interface ResolvedArtifact {
  name: string;
  body: string;
  manifest: { kind?: string; updatedAt?: string; title?: string; entry?: string } | null;
}

/**
 * Resolve the project's "current artifact" for the synthesis prompt.
 *
 * Priority order:
 *   1. The file referenced by `tabs.is_active = 1` IF it has an
 *      `<name>.artifact.json` sidecar present on disk. "Sidecar
 *      presence" is the discriminator: an inferred manifest (e.g. for
 *      a bare `.html` file with no sidecar) does NOT count, and an
 *      active tab pointing at a non-artifact file (`.md`, `.txt`)
 *      falls through.
 *   2. The newest project file with a real `.artifact.json` sidecar,
 *      sorted by `manifest.updatedAt` descending. Files without an
 *      `updatedAt` (legacy pre-streaming manifests) sort last.
 *   3. `null` — no artifact in scope. Caller emits `artifact: null`
 *      in the response and the prompt's "Current artifact" section
 *      reads "none".
 *
 * `metadata` is the project row's `metadata` field (from `getProject`).
 * For imported-folder projects, `metadata.baseDir` redirects file IO
 * to the user's actual folder; without it, this resolver would only
 * look under `.od/projects/<id>` and miss the real artifacts.
 *
 * Sidecar presence is checked via `existsSync` on the on-disk path so
 * the resolver does not depend on `inferLegacyManifest`'s heuristic.
 */
export async function resolveCurrentArtifact(
  db: Db,
  projectsRoot: string,
  projectId: string,
  metadata?: { baseDir?: string } | null,
): Promise<ResolvedArtifact | null> {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata ?? undefined);

  const activeTabRow = db
    .prepare(`SELECT name FROM tabs WHERE project_id = ? AND is_active = 1 LIMIT 1`)
    .get(projectId) as { name?: unknown } | undefined;
  const activeTabName =
    activeTabRow && typeof activeTabRow.name === 'string' ? activeTabRow.name : null;

  if (activeTabName) {
    // Validate the tab name BEFORE composing it into a filesystem path.
    // A malformed tab (e.g. `../../../etc/passwd` written by an attacker
    // with DB write access) would otherwise probe outside the project
    // dir via path.join. validateProjectPath throws on traversal
    // segments, absolute paths, null bytes, and reserved segments.
    // Invalid tab names fall through to the newest-artifact branch
    // rather than aborting finalize. P3 finding from @lefarcen on PR #832.
    let safeTabName: string | null = null;
    try {
      safeTabName = validateProjectPath(activeTabName);
    } catch {
      safeTabName = null;
    }
    if (safeTabName) {
      const sidecarPath = path.join(dir, `${safeTabName}.artifact.json`);
      if (!fs.existsSync(sidecarPath)) {
        await reconcileHtmlArtifactManifest(
          projectsRoot,
          projectId,
          safeTabName,
          metadata ?? undefined,
        );
      }
      if (fs.existsSync(sidecarPath)) {
        const file = await readProjectFile(
          projectsRoot,
          projectId,
          safeTabName,
          metadata ?? undefined,
        );
        return {
          name: file.name,
          body: file.buffer.toString('utf8'),
          manifest: file.artifactManifest ?? null,
        };
      }
    }
    // Active tab points at a non-artifact file (or an unsafe name) — fall
    // through to the newest-artifact branch.
  }

  const files = await listFiles(projectsRoot, projectId, { metadata: metadata ?? undefined });
  await Promise.all(
    files.map((f) => {
      if (fs.existsSync(path.join(dir, `${f.name}.artifact.json`))) return null;
      return reconcileHtmlArtifactManifest(
        projectsRoot,
        projectId,
        f.name,
        metadata ?? undefined,
      );
    }),
  );
  const reconciledFiles = await listFiles(projectsRoot, projectId, {
    metadata: metadata ?? undefined,
  });
  const candidates = reconciledFiles
    .filter((f) => {
      // Require a real sidecar on disk; an inferred manifest does not count.
      return fs.existsSync(path.join(dir, `${f.name}.artifact.json`));
    })
    .map((f) => {
      const manifest =
        f.artifactManifest && typeof f.artifactManifest === 'object'
          ? f.artifactManifest as { updatedAt?: unknown }
          : null;
      return {
        name: f.name,
        updatedAt: typeof manifest?.updatedAt === 'string' ? manifest.updatedAt : '',
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); // descending; '' sorts last

  if (candidates.length > 0) {
    const newest = await readProjectFile(
      projectsRoot,
      projectId,
      candidates[0]!.name,
      metadata ?? undefined,
    );
    return {
      name: newest.name,
      body: newest.buffer.toString('utf8'),
      manifest: newest.artifactManifest ?? null,
    };
  }

  return null;
}

const SYSTEM_PROMPT = `You are a senior product designer synthesizing a finalized design package
from a multi-turn design session. Your output is a single Markdown document
named DESIGN.md that captures the durable design intent of the work so a
fresh contributor (human or LLM) can reconstruct context without replaying
the full chat.

Output structure (Markdown headings exactly as below):
# DESIGN.md
## Summary
## Brand & Voice
## Information Architecture
## Components & Patterns
## Visual System
## Open Questions
## Provenance

The Provenance section MUST list:
- Project ID
- Design system (or "none" if not selected)
- Current artifact (file name, or "none" if not in scope)
- Transcript message count
- Generated UTC timestamp

Render Provenance fields as plain Markdown bullets with no emphasis on the field labels, exactly: "- Field name: value". Do not bold, italicize, or otherwise decorate the labels or the colon. Field values may use inline code formatting (backticks) where appropriate.

Output the Markdown body only. No preamble, no chat-style framing, no
"Here's your DESIGN.md" prefix. Do not invent facts not supported by the
inputs; if an input is missing or empty, the corresponding section should
say so explicitly rather than fabricating content.`;

export interface SynthesisPromptInput {
  projectId: string;
  transcriptJsonl: string;
  transcriptMessageCount: number;
  designSystemId: string | null;
  designSystemBody: string | null;
  artifact: ResolvedArtifact | null;
  now: Date;
}

export interface SynthesisPromptOutput {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Build the system + user prompts for the DESIGN.md synthesis call.
 * Inputs are verbatim except for the transcript (which the caller has
 * already passed through `truncateTranscriptForPrompt` — this function
 * does not re-truncate). Missing inputs (no design system selected, no
 * artifact in scope) produce explicit "none"/parenthetical placeholders
 * so the model does not hallucinate content for absent sections.
 */
export function buildSynthesisPrompt(input: SynthesisPromptInput): SynthesisPromptOutput {
  const designSystemHeader = input.designSystemId ?? 'none';
  const designSystemBody =
    input.designSystemBody && input.designSystemBody.trim().length > 0
      ? input.designSystemBody
      : '(no design system selected for this project)';

  const artifactHeader = input.artifact ? input.artifact.name : 'none';
  const artifactBody = input.artifact
    ? input.artifact.body
    : '(no artifact in scope for this finalize)';

  const userPrompt =
    `The following inputs describe the design session for project ${input.projectId}.\n\n` +
    `## Transcript (JSONL)\n${input.transcriptJsonl}\n\n` +
    `## Active design system: ${designSystemHeader}\n${designSystemBody}\n\n` +
    `## Current artifact: ${artifactHeader}\n${artifactBody}\n\n` +
    `## Generation context\n` +
    `- Generated at: ${input.now.toISOString()}\n` +
    `- Project ID: ${input.projectId}\n` +
    `- Transcript message count: ${input.transcriptMessageCount}\n\n` +
    `Synthesize DESIGN.md per the system instructions.`;

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

/**
 * Truncate a JSONL transcript body so it fits inside Claude's context
 * window when fed into a synthesis prompt. The on-disk transcript stays
 * untouched (PR #493's lossless contract); this function operates on a
 * copy that lives only in the prompt.
 *
 * Strategy: keep the header line (line 0); if the remaining body exceeds
 * INPUT_BODY_CAP_BYTES (minus the header + marker reservation), retain
 * head and tail lines in roughly equal byte budgets and drop the middle
 * with a single sentinel JSON line:
 *
 *   {"kind":"truncated","reason":"size","omittedBytes":<N>}
 *
 * `omittedBytes` is the difference between the original UTF-8 byte
 * length and the truncated output's UTF-8 byte length, so a synthesis
 * consumer can detect the gap.
 *
 * If head + tail budgets together cover the whole body (e.g. all message
 * lines are tiny), no marker is emitted; the output is the input
 * verbatim.
 */
export function truncateTranscriptForPrompt(jsonl: string): string {
  const buf = Buffer.from(jsonl, 'utf8');
  if (buf.byteLength <= INPUT_BODY_CAP_BYTES) return jsonl;

  const lines = jsonl.split('\n');
  const header = lines[0] ?? '';
  const body = lines.slice(1);

  const markerLine = '{"kind":"truncated","reason":"size","omittedBytes":__N__}';
  const reservedBytes =
    Buffer.byteLength(header + '\n', 'utf8') +
    Buffer.byteLength(markerLine + '\n', 'utf8') +
    64;
  const perSideBudget = Math.floor((INPUT_BODY_CAP_BYTES - reservedBytes) / 2);

  const headLines: string[] = [];
  let headBytes = 0;
  let headIndex = 0;
  for (; headIndex < body.length; headIndex += 1) {
    const line = body[headIndex] ?? '';
    const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
    if (headBytes + lineBytes > perSideBudget) break;
    headLines.push(line);
    headBytes += lineBytes;
  }

  const tailLines: string[] = [];
  let tailBytes = 0;
  for (let i = body.length - 1; i >= headIndex; i -= 1) {
    const line = body[i] ?? '';
    const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
    if (tailBytes + lineBytes > perSideBudget) break;
    tailLines.unshift(line);
    tailBytes += lineBytes;
  }

  if (headLines.length + tailLines.length >= body.length) {
    // Head + tail covers the whole body — no truncation needed beyond the
    // marker reservation. Return verbatim.
    return [header, ...headLines, ...tailLines].join('\n');
  }

  const without = [header, ...headLines, ...tailLines].join('\n');
  const omittedBytes = buf.byteLength - Buffer.byteLength(without, 'utf8');
  const marker = markerLine.replace('__N__', String(omittedBytes));
  return [header, ...headLines, marker, ...tailLines].join('\n');
}
