import { test } from 'vitest';
import {
  assert, checkPromptArgvBudget, checkWindowsCmdShimCommandLineBudget, checkWindowsDirectExeCommandLineBudget, claude, copilot,
} from './helpers/test-helpers.js';

// Zero Two ships two agents, and both deliver the prompt over stdin
// (claude `-p` stream-json; copilot stdin) rather than as a positional
// argv entry, so neither declares `maxPromptArgBytes`. The argv/command-
// line budget guards therefore must always no-op for them — applying a
// byte budget to a stdin-delivered prompt would refuse perfectly valid
// large prompts those CLIs handle fine. These tests pin that invariant so
// a future change that starts flagging stdin adapters fails loudly.

test('claude and copilot declare no argv-byte prompt budget', () => {
  assert.equal(claude.maxPromptArgBytes, undefined);
  assert.equal(copilot.maxPromptArgBytes, undefined);
});

test('checkPromptArgvBudget is a no-op for stdin adapters regardless of prompt size', () => {
  const huge = 'x'.repeat(100_000);
  assert.equal(checkPromptArgvBudget(claude, huge), null);
  assert.equal(checkPromptArgvBudget(copilot, huge), null);
});

test('checkWindowsCmdShimCommandLineBudget skips stdin adapters even on a .cmd resolution', () => {
  assert.equal(
    checkWindowsCmdShimCommandLineBudget(claude, 'C:\\fake\\claude.cmd', []),
    null,
  );
  assert.equal(
    checkWindowsCmdShimCommandLineBudget(copilot, 'C:\\fake\\copilot.cmd', []),
    null,
  );
});

test('checkWindowsDirectExeCommandLineBudget skips stdin adapters even on a .exe resolution', () => {
  assert.equal(
    checkWindowsDirectExeCommandLineBudget(claude, 'C:\\fake\\claude.exe', []),
    null,
  );
  assert.equal(
    checkWindowsDirectExeCommandLineBudget(copilot, 'C:\\fake\\copilot.exe', []),
    null,
  );
});

test('command-line budget guards no-op when resolvedBin is null or empty', () => {
  assert.equal(checkWindowsCmdShimCommandLineBudget(claude, null, []), null);
  assert.equal(checkWindowsDirectExeCommandLineBudget(claude, null, []), null);
  assert.equal(checkWindowsDirectExeCommandLineBudget(claude, '', []), null);
});
