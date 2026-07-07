import { test } from 'vitest';
import {
  AGENT_DEFS, assert, chmodSync, claude, detectAgents, join, mkdtempSync, rmSync, tmpdir, withEnvSnapshot, writeFileSync,
} from './helpers/test-helpers.js';

test('AGENT_DEFS ids are unique', () => {
  const ids = AGENT_DEFS.map((a) => a.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate agent ids: ${JSON.stringify(dupes)}`);
});

test('claude probes auth status so rescans reflect CLI auth changes', async () => {
  assert.deepEqual(claude.authProbe, {
    args: ['auth', 'status'],
    timeoutMs: 5000,
  });

  const dir = mkdtempSync(join(tmpdir(), 'od-agents-claude-auth-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME', 'CLAUDE_BIN'], async () => {
      const claudeBin = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      if (process.platform === 'win32') {
        writeFileSync(
          claudeBin,
          '@echo off\r\nif "%~1"=="--version" (\r\n  echo 2.1.168\r\n  exit /b 0\r\n)\r\nif "%~1"=="-p" (\r\n  echo --include-partial-messages --add-dir\r\n  exit /b 0\r\n)\r\nif "%~1"=="auth" if "%~2"=="status" (\r\n  echo {"authenticated":true,"source":"claude.ai"}\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n',
        );
      } else {
        writeFileSync(
          claudeBin,
          `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.168 (Claude Code)"; exit 0; fi
if [ "$1" = "-p" ] && [ "$2" = "--help" ]; then echo "--include-partial-messages --add-dir"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"authenticated":true,"source":"claude.ai"}'; exit 0; fi
exit 0
`,
        );
        chmodSync(claudeBin, 0o755);
      }
      process.env.OD_AGENT_HOME = dir;
      process.env.PATH = dir;
      delete process.env.CLAUDE_BIN;

      const agents = await detectAgents();
      const detected = agents.find((agent) => agent.id === 'claude');

      assert.ok(detected);
      assert.equal(detected.available, true);
      assert.equal(detected.authStatus, 'ok');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
