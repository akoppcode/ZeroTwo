// @ts-nocheck
// LLM-driven memory extractor.
//
// The heuristic regex pack in `memory.ts` only catches explicit markers
// ("remember:", "记住", "我喜欢"…). For everything else — implicit
// preferences, role, ongoing-work context — we ask a small fast model
// to look at the just-finished turn and the existing memory and return
// a JSON list of facts to add.
//
// This module is fire-and-forget: the chat run finishes and triggers
// extraction in the background. Output lands in the same MD store so
// the next turn's prompt picks it up automatically.
//
// Extraction runs exclusively through the local CLI agent the user is
// already chatting with — Claude Code is the only agent with a headless
// one-shot mode we can reduce back to assistant text. When the caller
// didn't pass a supported `chatAgentId`, we record a
// 'skipped: no-provider' attempt so the UI can surface "chat through a
// supported CLI to enable LLM memory" instead of staying silent.
//
// Every attempt — whether it actually called the model or short-circuited
// — produces a record in `memory-extractions.ts` so the settings panel
// can show running / skipped / success / failed states in real time.

import { MEMORY_TYPES } from '@open-design/contracts';
import {
  composeMemoryBody,
  listMemoryEntries,
  readMemoryConfig,
  upsertMemoryEntry,
  memoryEvents,
} from './memory.js';
import {
  startExtraction,
  recordSkip,
  markProvider,
  markSkipped,
  markProposed,
  markSuccess,
  markFailed,
} from './memory-extractions.js';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createCommandInvocation } from '@open-design/platform';
import {
  applyAgentLaunchEnv,
  getAgentDef,
  resolveAgentLaunch,
  spawnEnvForAgent,
} from './agents.js';
import { agentCliEnvForAgent, readAppConfig } from './app-config.js';

const SYSTEM_PROMPT = `You are a memory extractor for a personal AI design assistant.

Given the user's most recent message (and optionally the assistant's reply), plus a snapshot of the existing memory store, decide whether ANYTHING in this turn is worth remembering across future conversations.

A fact is worth remembering when ALL of these are true:
- It's about the user, their preferences, their tools, their ongoing work, OR a stable reference (a Linear board id, a Slack channel, a teammate name).
- It will plausibly still be true in a week.
- It would change how an assistant responds in a later, unrelated chat.

A fact is NOT worth remembering when ANY of these is true:
- It's a transient state (current task, what file they're editing right now).
- It's already captured in the existing memory.
- It's just the user asking a question or describing a one-off bug.
- It's something the assistant said about itself.
- It's a code snippet, an output, or a paste.

Output STRICT JSON in this exact shape — nothing else, no prose, no markdown fences:
{
  "entries": [
    { "type": "user|feedback|project|reference", "name": "short title (≤ 60 chars)", "description": "one-line summary (≤ 140 chars)", "body": "the actual remembered fact, 1-3 sentences" }
  ]
}

If there's nothing worth remembering, return: {"entries": []}

Type rules:
- user: who they are, role, expertise, long-term goals
- feedback: corrections / preferences about how to work ("don't add comments unless asked")
- project: ongoing initiatives, deadlines, why-decisions; usually time-bounded
- reference: pointers to external systems (Linear projects, Slack channels, dashboards)`;

// Specialised system prompt for the annotation distiller. The user just
// reviewed a generated design artifact and left inline marks — comments,
// highlights, or drawn strokes — on specific elements. We turn the durable
// signal in those marks into `feedback` (a standing preference) and `rule`
// (an enforceable, checkable constraint) memory so the next generation honors
// it without the user re-explaining. The output shape matches the generic
// extractor so the same parser/writer pipeline applies.
const ANNOTATION_SYSTEM_PROMPT = `You are a memory distiller for a personal AI design assistant.

The user just reviewed a generated design artifact and left inline annotations — comments, highlights, or drawn marks — each attached to a specific element. Your job is to distill any STANDING design preference or constraint the user is expressing, so future generations honor it without the user repeating themselves.

Only extract a fact when the annotation expresses a durable preference that should apply to FUTURE work — never a one-off tweak to this single element.
- "make THIS button green" → one-off, do NOT remember.
- "always use the brand green for primary actions" / a complaint they clearly keep making → durable, remember.
- "too busy" / "太花了" as a recurring critique → remember as feedback about visual density / decoration.

Generalize the wording so it is not tied to this one element, page, or run.

Output STRICT JSON in this exact shape — nothing else, no prose, no markdown fences:
{
  "entries": [
    { "type": "feedback|rule", "name": "short title (≤ 60 chars)", "description": "one-line summary (≤ 140 chars)", "body": "the remembered preference/rule" }
  ]
}

If nothing is durable, return: {"entries": []}

Type rules:
- feedback: a preference about how to work or what the user likes/dislikes ("keep decoration minimal — at most two accent colors").
- rule: an enforceable, checkable constraint. The body MUST be exactly two lines:
  Assertion: <what must always hold in the output>
  Check: <how to verify it on a rendered artifact>`;

// Pick the extraction provider. The only execution path is the local
// CLI the user is already chatting with, and Claude Code is the only
// agent with a headless one-shot mode that accepts stdin and returns
// plain assistant text. Anything else — including no `chatAgentId` at
// all — returns null so the caller records a 'skipped: no-provider'
// attempt instead of staying silent.
//
// The `OD_MEMORY_MODEL` env overrides the model passed to the CLI so
// power users can pin extraction to a cheaper/faster model than the
// chat model.
function pickProvider(chatAgentId, chatModel) {
  const agentId =
    typeof chatAgentId === 'string' ? chatAgentId.trim().toLowerCase() : '';
  if (agentId !== 'claude') return null;
  const model = process.env.OD_MEMORY_MODEL || chatModel;
  return {
    kind: 'anthropic',
    model: (typeof model === 'string' && model.trim()) || 'default',
    credentialSource: 'chat-cli',
    agentId,
  };
}

function renderUserPayload({ userMessage, assistantMessage, currentMemory }) {
  const parts = [];
  parts.push('## Existing memory');
  parts.push(currentMemory && currentMemory.trim().length > 0
    ? currentMemory
    : '(empty)');
  parts.push('');
  parts.push('## User message');
  parts.push(String(userMessage || '').slice(0, 4000));
  if (assistantMessage && assistantMessage.trim().length > 0) {
    parts.push('');
    parts.push('## Assistant reply');
    parts.push(String(assistantMessage).slice(0, 4000));
  }
  parts.push('');
  parts.push(
    'Return ONLY the JSON object described in the system prompt — no prose, no fences.',
  );
  return parts.join('\n');
}

const LOCAL_CLI_TIMEOUT_MS = 60_000;

async function callLocalCli(provider, system, user, options) {
  if (typeof options?.localCliRunner === 'function') {
    return options.localCliRunner({
      agentId: provider.agentId,
      model: provider.model,
      system,
      user,
      projectRoot: options?.projectRoot ?? null,
      dataDir: options?.dataDir ?? null,
    });
  }

  const def = getAgentDef(provider.agentId);
  if (!def) {
    throw new Error(`Local CLI agent "${provider.agentId}" is not installed`);
  }

  let configuredAgentEnv = {};
  try {
    const appConfig = options?.dataDir ? await readAppConfig(options.dataDir) : {};
    configuredAgentEnv = agentCliEnvForAgent(appConfig.agentCliEnv, def.id);
  } catch {
    configuredAgentEnv = {};
  }

  const launch = resolveAgentLaunch(def, configuredAgentEnv);
  if (!launch?.launchPath) {
    throw new Error(`${def.name} CLI is not installed or not on PATH`);
  }

  // The memory extractor is a tool-less, JSON-only background call that never
  // reads project files, so it has no reason to run in the daemon's own cwd.
  // Use a neutral temp cwd when no project root is available.
  const cwd =
    typeof options?.projectRoot === 'string' && options.projectRoot.trim()
      ? options.projectRoot
      : os.tmpdir();
  const prompt = [
    system,
    '',
    'You are running as a background memory extractor. Do not use tools. Return strict JSON only.',
    '',
    user,
  ].join('\n');

  if (provider.agentId !== 'claude') {
    throw new Error(`Local CLI memory extraction is not supported for ${provider.agentId}`);
  }
  const args = ['-p', '--input-format', 'text', '--output-format', 'text'];
  if (provider.model && provider.model !== 'default') {
    args.push('--model', provider.model);
  }
  const stdinText = prompt;

  const env = applyAgentLaunchEnv(
    spawnEnvForAgent(
      def.id,
      { ...process.env, ...(def.env || {}) },
      configuredAgentEnv,
      undefined,
      { resolvedBin: launch.selectedPath },
    ),
    launch,
  );
  const invocation = createCommandInvocation({
    command: launch.launchPath,
    args,
    env,
  });

  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let closed = false;
    const child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(text);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 2_000).unref?.();
      finish(new Error(`${def.name} CLI timed out after ${Math.round(LOCAL_CLI_TIMEOUT_MS / 1000)}s`));
    }, LOCAL_CLI_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once('error', (err) => finish(err));
    child.once('close', (code, signal) => {
      closed = true;
      if (code === 0) {
        const text = stdout.trim();
        if (text) {
          finish(null, text);
          return;
        }
      }
      const detail = (stderr.trim() || stdout.trim() || 'no output').slice(0, 1000);
      const status = signal ? `signal ${signal}` : `exit ${code}`;
      finish(new Error(`${def.name} CLI ${status}: ${detail}`));
    });
    child.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') finish(err);
    });
    child.stdin.end(stdinText);
  });
}

// Tolerant JSON parse — the model occasionally wraps output in ```json
// fences even when told not to. Strip those defensively.
function parseEntries(rawText) {
  if (typeof rawText !== 'string') return [];
  let text = rawText.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Last-ditch: pull the first {...} block.
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
  // Accept every type the shared contract knows about — including the new
  // `profile` / `rule` buckets — so an LLM that proposes a verified rule or a
  // profile fact isn't silently discarded here.
  const validTypes = new Set(MEMORY_TYPES);
  return list
    .filter(
      (e) =>
        e &&
        typeof e === 'object' &&
        validTypes.has(e.type) &&
        typeof e.name === 'string' &&
        e.name.trim().length > 0 &&
        typeof e.body === 'string' &&
        e.body.trim().length > 0,
    )
    .slice(0, 6); // hard cap so a confused model can't flood the store
}

function alreadyKnown(existing, candidate) {
  const candKey = `${candidate.type}::${candidate.name.toLowerCase().trim()}`;
  for (const e of existing) {
    if (`${e.type}::${e.name.toLowerCase().trim()}` === candKey) return true;
  }
  return false;
}

function toMemoryDraft(candidate) {
  return {
    type: candidate.type,
    name: String(candidate.name).trim().slice(0, 80),
    description: String(candidate.description || '').trim().slice(0, 200),
    body: String(candidate.body).trim(),
  };
}

async function collectProposedEntries(dataDir, input, options) {
  const projectRoot = options?.projectRoot ?? null;
  const chatAgentId = options?.chatAgentId ?? null;
  const chatModel = options?.chatModel ?? null;
  const extractionKind = options?.kind ?? 'llm';
  const systemPrompt =
    typeof options?.systemPrompt === 'string' && options.systemPrompt.trim()
      ? options.systemPrompt.trim()
      : SYSTEM_PROMPT;
  const userMessage = String(input?.userMessage || '').trim();

  const cfg = await readMemoryConfig(dataDir);
  if (!cfg.enabled) {
    recordSkip({ userMessage, reason: 'memory-disabled', kind: extractionKind });
    return { status: 'skipped', attemptId: null, proposed: [], existingEntries: [] };
  }
  if (extractionKind !== 'connector' && !cfg.chatExtractionEnabled) {
    return { status: 'skipped', attemptId: null, proposed: [], existingEntries: [] };
  }
  if (userMessage.length === 0) {
    recordSkip({ userMessage, reason: 'empty-message', kind: extractionKind });
    return { status: 'skipped', attemptId: null, proposed: [], existingEntries: [] };
  }

  const provider = pickProvider(chatAgentId, chatModel);
  if (!provider) {
    recordSkip({ userMessage, reason: 'no-provider', kind: extractionKind });
    return { status: 'skipped', attemptId: null, proposed: [], existingEntries: [] };
  }

  // Past this point we have a provider committed and an actual model
  // call about to happen — switch from one-shot skip records to a
  // running record we can update through phase transitions.
  const attemptId = startExtraction({ userMessage, kind: extractionKind });
  markProvider(attemptId, {
    kind: provider.kind,
    model: provider.model,
    credentialSource: provider.credentialSource,
  });

  let currentMemory = '';
  let existingEntries = [];
  try {
    [currentMemory, existingEntries] = await Promise.all([
      composeMemoryBody(dataDir),
      listMemoryEntries(dataDir),
    ]);
  } catch {
    // Fresh store — proceed with empty context.
  }

  const userPayload = renderUserPayload({
    userMessage,
    assistantMessage: input?.assistantMessage,
    currentMemory,
  });

  let raw = '';
  try {
    raw = await callLocalCli(provider, systemPrompt, userPayload, {
      dataDir,
      projectRoot,
      localCliRunner: options?.localCliRunner,
    });
  } catch (err) {
    console.warn(`[memory-llm] ${provider.kind} call failed`, err?.message ?? err);
    markFailed(attemptId, err);
    return { status: 'failed', attemptId, proposed: [], existingEntries };
  }

  let proposed;
  try {
    proposed = parseEntries(raw);
    if (typeof options?.candidateFilter === 'function') {
      proposed = proposed.filter((candidate) => {
        try {
          return options.candidateFilter(candidate);
        } catch {
          return false;
        }
      });
    }
  } catch (err) {
    markFailed(attemptId, err);
    return { status: 'failed', attemptId, proposed: [], existingEntries };
  }
  markProposed(attemptId, proposed.length);
  return { status: 'ok', attemptId, proposed, existingEntries };
}

export async function suggestWithLLM(dataDir, input, options) {
  const result = await collectProposedEntries(dataDir, input, options);
  if (result.status !== 'ok') return [];

  const suggestions = result.proposed
    .filter((cand) => !alreadyKnown(result.existingEntries, cand))
    .map(toMemoryDraft);

  markSuccess(result.attemptId, {
    writtenCount: 0,
    writtenIds: [],
  });

  return suggestions;
}

// Build the distiller payload from a turn's annotations. Each annotation is
// the user's words plus enough target context (what element, its current
// copy, the mark intent) for the model to judge whether the critique is a
// one-off or a standing preference. The typed message that rode along with
// the annotations is appended as extra context.
function renderAnnotationPayload(annotations, userMessage) {
  const parts = [
    'The user reviewed a generated design artifact and left these inline annotations:',
  ];
  annotations.forEach((a, index) => {
    parts.push('');
    parts.push(`Annotation ${index + 1}:`);
    parts.push(`- comment: ${String(a.comment || '').trim()}`);
    if (a.label) parts.push(`- target element: ${String(a.label).trim()}`);
    if (a.currentText) {
      parts.push(`- target current text: ${String(a.currentText).trim().slice(0, 240)}`);
    }
    if (a.selectionKind) parts.push(`- selection kind: ${a.selectionKind}`);
    if (a.intent) parts.push(`- mark intent: ${a.intent}`);
    if (a.markKind) parts.push(`- mark kind: ${a.markKind}`);
  });
  const trimmedMessage = String(userMessage || '').trim();
  if (trimmedMessage.length > 0) {
    parts.push('');
    parts.push('The message the user sent alongside the annotations:');
    parts.push(trimmedMessage.slice(0, 2000));
  }
  parts.push('');
  parts.push(
    'Return ONLY the JSON object described in the system prompt — no prose, no fences.',
  );
  return parts.join('\n');
}

// Auto-distill preview annotations (comments / highlights / drawn marks) into
// durable `feedback` and `rule` memory. This is the automatic half of the
// "interaction → memory" loop: instead of waiting for the agent to propose a
// rule and the user to click Keep, every review turn that carries inline
// feedback is mined in the background and written straight to the store
// (auto-keep), de-duped against existing entries. Reuses extractWithLLM so the
// provider selection, memory toggles, dedup, index linking, and the batched
// `extract` change event (which drives the "Memory updated" toast) all apply.
//
// `input.annotations` is the turn's comment-attachment list; only annotations
// carrying a non-empty user comment are mined (a bare highlight with no words
// has no durable signal to distill). Returns the written entries.
export async function distillAnnotationsToMemory(dataDir, input, options) {
  const annotations = Array.isArray(input?.annotations) ? input.annotations : [];
  const withComment = annotations.filter(
    (a) => a && typeof a.comment === 'string' && a.comment.trim().length > 0,
  );
  if (withComment.length === 0) return [];
  const payload = renderAnnotationPayload(withComment, input?.userMessage);
  return extractWithLLM(
    dataDir,
    { userMessage: payload, assistantMessage: input?.assistantMessage },
    {
      ...options,
      systemPrompt: ANNOTATION_SYSTEM_PROMPT,
      source: 'annotation',
      kind: 'annotation',
      // The distiller only deals in durable preferences/constraints — never
      // let it spawn project/reference/user noise from a design critique.
      candidateFilter: (candidate) =>
        candidate.type === 'feedback' || candidate.type === 'rule',
    },
  );
}

export async function extractWithLLM(dataDir, input, options) {
  const changeSource = options?.source ?? 'llm';
  const result = await collectProposedEntries(dataDir, input, options);
  if (result.status !== 'ok') return [];
  const { attemptId, proposed, existingEntries } = result;

  if (proposed.length === 0) {
    markSuccess(attemptId, { writtenCount: 0, writtenIds: [] });
    return [];
  }

  const written = [];
  for (const cand of proposed) {
    if (alreadyKnown(existingEntries, cand)) continue;
    try {
      const entry = await upsertMemoryEntry(
        dataDir,
        toMemoryDraft(cand),
        // Suppress per-entry events; we batch a single 'extract' below
        // so the toast says "Memory updated (3 · LLM)" once.
        { silent: true, source: changeSource },
      );
      written.push({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        updatedAt: entry.updatedAt,
      });
    } catch (err) {
      console.warn('[memory-llm] write failed', err?.message ?? err);
    }
  }

  if (written.length > 0) {
    memoryEvents.emit('change', {
      kind: 'extract',
      count: written.length,
      source: changeSource,
      at: Date.now(),
    });
  }

  markSuccess(attemptId, {
    writtenCount: written.length,
    writtenIds: written.map((e) => e.id),
  });

  return written;
}
