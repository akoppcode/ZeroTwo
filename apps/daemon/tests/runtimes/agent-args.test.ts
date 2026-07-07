import { test } from 'vitest';
import {
  assert, claude, copilot,
} from './helpers/test-helpers.js';

// Copilot reads the prompt from stdin when `-p` is omitted entirely
// (upstream copilot-cli issue #1046, confirmed working as
// `echo "..." | copilot --model <id>`). The earlier `-p -` attempt
// was a dead end because Copilot takes `-` as a literal one-character
// prompt; omitting `-p` is a separate code path that does delegate to
// stdin under a non-TTY pipe. Pin `promptViaStdin: true` and the
// stdin-only argv shape so a future refactor can't silently bring
// `-p <prompt>` back and reintroduce the Windows ENAMETOOLONG
// regression (issue #705).
test('copilot delivers the prompt via stdin (no -p, no prompt body in argv)', () => {
  const prompt = 'design a landing page';
  const baseArgs = copilot.buildArgs(prompt, [], [], {});
  assert.equal(copilot.promptViaStdin, true);
  assert.ok(
    !baseArgs.includes('-p'),
    'copilot argv must not include -p; the prompt rides stdin',
  );
  assert.ok(
    !baseArgs.includes(prompt),
    'copilot argv must not include the prompt body; it rides stdin',
  );
  assert.deepEqual(baseArgs, [
    '--allow-all-tools',
    '--output-format',
    'json',
  ]);
});

test('copilot args append model and extra dirs after the base flags without reintroducing -p', () => {
  const prompt = 'design a landing page';
  const args = copilot.buildArgs(
    prompt,
    [],
    ['/tmp/od-skills', '/tmp/od-design-systems'],
    { model: 'claude-sonnet-4.6' },
  );
  assert.ok(!args.includes('-p'));
  assert.ok(!args.includes(prompt));
  assert.deepEqual(args, [
    '--allow-all-tools',
    '--output-format',
    'json',
    '--model',
    'claude-sonnet-4.6',
    '--add-dir',
    '/tmp/od-skills',
    '--add-dir',
    '/tmp/od-design-systems',
  ]);
});

test('copilot drops empty / non-string entries from extraAllowedDirs without reintroducing -p', () => {
  const prompt = 'design a landing page';
  const args = copilot.buildArgs(
    prompt,
    [],
    ['', null, '/tmp/od-skills', undefined] as unknown as string[],
    {},
  );
  assert.ok(!args.includes('-p'));
  // Only the one valid path survives.
  const addDirIndex = args.indexOf('--add-dir');
  assert.equal(args[addDirIndex + 1], '/tmp/od-skills');
  assert.equal(args.filter((a) => a === '--add-dir').length, 1);
});

// Mirror of the Claude Code 200_000-char synthetic-prompt guard: even
// when the composed prompt is large enough to blow the Windows
// CreateProcess command-line cap (~32 KB direct, ~8 KB through a `.cmd`
// shim), no argv entry must ever carry the prompt body. This is the
// structural assertion that the issue #705 fix can't quietly regress.
test('copilot flags promptViaStdin and never embeds the prompt in argv', () => {
  assert.equal(copilot.promptViaStdin, true);

  const longPrompt = 'x'.repeat(200_000);
  const args = copilot.buildArgs(longPrompt, [], [], {});

  assert.ok(Array.isArray(args), 'copilot.buildArgs must return argv');
  assert.equal(
    args.includes(longPrompt),
    false,
    'prompt must not appear in argv',
  );
  for (const arg of args) {
    assert.ok(
      typeof arg === 'string' && arg.length < 1000,
      `no argv entry should carry the prompt body (saw length ${arg.length})`,
    );
  }
});

test('claude flags promptViaStdin and never embeds the prompt in argv', () => {
  // Long composed prompts (system prompt + design system + skill body +
  // user message) routinely exceed Linux MAX_ARG_STRLEN (~128 KB) and the
  // Windows CreateProcess command-line cap (~32 KB direct, ~8 KB via .cmd
  // shim). The fix is to deliver the prompt on stdin instead of argv —
  // these assertions guard that contract.
  assert.equal(claude.promptViaStdin, true);

  const longPrompt = 'x'.repeat(200_000);
  const args = claude.buildArgs(
    longPrompt,
    [],
    [],
    {},
    { cwd: '/tmp/od-project' },
  );

  assert.ok(Array.isArray(args), 'claude.buildArgs must return argv');
  assert.equal(
    args.includes(longPrompt),
    false,
    'prompt must not appear in argv',
  );
  for (const arg of args) {
    assert.ok(
      typeof arg === 'string' && arg.length < 1000,
      `no argv entry should carry the prompt body (saw length ${arg.length})`,
    );
  }
  // `-p` (print mode) must still be present; without it claude drops into
  // an interactive REPL that the daemon has no TTY for.
  assert.ok(args.includes('-p'), 'claude argv must include -p');
});

// ---- Claude Code --add-dir capability (issue #430) -------------------------
// Skill seeds (`skills/<id>/assets/template.html`) and design-system specs
// (`design-systems/<id>/DESIGN.md`) live outside the project cwd. Without
// `--add-dir`, Claude Code's directory access policy blocks reads on any
// path outside the working directory. Bug was that we probed global `claude
// --help` for `--add-dir` but that flag only appears in `claude -p --help`.

test('claude buildArgs passes --add-dir when dirs are supplied (issue #430, probing-failed baseline)', () => {
  // This is the default state before any capability probe runs: agentCapabilities
  // has no entry -> buildArgs gets `caps = {}` -> caps.addDir is undefined ->
  // undefined !== false -> true. This is also the "probing threw" case: timeout,
  // binary not found, non-zero exit code from --help. Dirs are always passed
  // unless capability probing explicitly detected --help and found no --add-dir.
  const args = claude.buildArgs(
    '',
    [],
    ['/repo/skills', '/repo/design-systems'],
    {},
  );

  const addDirIndex = args.indexOf('--add-dir');
  assert.ok(addDirIndex >= 0, '--add-dir must be present by default (safe baseline)');
  assert.equal(args[addDirIndex + 1], '/repo/skills');
  assert.equal(args[addDirIndex + 2], '/repo/design-systems');
  // Check flag ordering: --add-dir comes before --permission-mode
  const permModeIndex = args.indexOf('--permission-mode');
  assert.ok(
    addDirIndex < permModeIndex,
    `--add-dir (index ${addDirIndex}) should appear before --permission-mode (index ${permModeIndex})`,
  );
});

test('claude buildArgs drops empty / null dirs but keeps valid ones (issue #430 edge case)', () => {
  const args = claude.buildArgs('', [], ['', null, '/repo/skills', undefined] as unknown as string[], {});

  const addDirIndex = args.indexOf('--add-dir');
  assert.ok(addDirIndex >= 0, '--add-dir should survive filter');
  // Only the one valid path survives after --add-dir.
  assert.equal(args[addDirIndex + 1], '/repo/skills');
  // Should NOT have multiple --add-dir flags (one flag, N arguments).
  assert.equal(args.filter((a) => a === '--add-dir').length, 1);
  // Should NOT have null / undefined / '' sneaking into argv.
  assert.equal(args.includes(''), false);
  assert.equal(args.includes(null as unknown as string), false);
  assert.equal(args.includes(undefined as unknown as string), false);
});

test('claude helpArgs probes the -p subcommand where --add-dir lives (issue #430 root cause)', () => {
  assert.deepEqual(
    claude.helpArgs,
    ['-p', '--help'],
    `claude.helpArgs must be ['-p', '--help'], not just ['--help'], because --add-dir lives under the -p subcommand. Probing global help never finds it! Got: ${JSON.stringify(claude.helpArgs)}`,
  );
});

// server.ts:4615 branches on `def.promptInputFormat` to decide how to write
// the composed prompt to a stdin-fed child: 'stream-json' writes one JSONL
// `user` message and keeps stdin open, anything else writes the raw prompt
// and ends stdin. Because server.ts opens with `// @ts-nocheck`, a typo on
// that property (e.g. an undefined `runtimeAdapter.promptInputFormat()`)
// passes typecheck but throws `ReferenceError` at runtime for every chat
// run that goes through the stdin-write path — i.e. every agent below.
// Pin the field shape so a future regression of that contract fails here
// instead of in production.
test('promptInputFormat is a string property (or undefined) on every promptViaStdin agent', () => {
  const stdinAgents = [
    { name: 'claude', def: claude, expected: 'stream-json' },
    { name: 'copilot', def: copilot, expected: undefined },
  ];
  for (const { name, def, expected } of stdinAgents) {
    assert.equal(
      def.promptViaStdin,
      true,
      `${name} must keep promptViaStdin: true`,
    );
    assert.equal(
      typeof def.promptInputFormat,
      typeof expected,
      `${name}.promptInputFormat must be a ${typeof expected}, not a function — server.ts reads it as a property, not a method call`,
    );
    assert.equal(
      def.promptInputFormat,
      expected,
      `${name}.promptInputFormat must equal ${JSON.stringify(expected)}`,
    );
  }
});
