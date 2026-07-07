import { test, vi } from 'vitest';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as platform from '@open-design/platform';
import {
  assert, chmodSync, detectAgents, inspectAgentExecutableResolution, join, minimalAgentDef, mkdirSync, mkdtempSync, resolveAgentExecutable, rmSync, spawnEnvForAgent, tmpdir, withEnvSnapshot, withPlatform, writeFileSync,
} from './helpers/test-helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// Zero Two is subscription-only auth: the spawned CLI must always
// authenticate via its own login state, never an API key from the
// inherited environment.
test('spawnEnvForAgent strips inherited Anthropic API credentials for the claude adapter', () => {
  const env = spawnEnvForAgent('claude', {
    ANTHROPIC_API_KEY: 'sk-leak',
    ANTHROPIC_AUTH_TOKEN: 'sk-token-leak',
    PATH: '/usr/bin',
    OD_DAEMON_URL: 'http://127.0.0.1:7456',
  });

  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OD_DAEMON_URL, 'http://127.0.0.1:7456');
});

test('spawnEnvForAgent applies configured Claude Code env while stripping inherited auth keys', () => {
  const env = spawnEnvForAgent(
    'claude',
    {
      ANTHROPIC_API_KEY: 'sk-leak',
      ANTHROPIC_AUTH_TOKEN: 'sk-token-leak',
      PATH: '/usr/bin',
    },
    {
      CLAUDE_CONFIG_DIR: '/Users/test/.claude-2',
    },
  );

  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/test/.claude-2');
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('spawnEnvForAgent strips even configured Anthropic API credentials', () => {
  const env = spawnEnvForAgent(
    'claude',
    {
      ANTHROPIC_API_KEY: 'sk-inherited-stale',
      ANTHROPIC_AUTH_TOKEN: 'sk-inherited-token',
      PATH: '/usr/bin',
    },
    {
      ANTHROPIC_API_KEY: 'sk-configured',
      ANTHROPIC_AUTH_TOKEN: 'sk-configured-token',
    },
  );

  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('spawnEnvForAgent reapplies sandbox state roots after configured env overrides', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'od-agent-env-sandbox-'));
  try {
    const claudeEnv = spawnEnvForAgent(
      'claude',
      {
        OD_DATA_DIR: dataDir,
        OD_SANDBOX_MODE: '1',
        PATH: '/usr/bin',
      },
      {
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-host',
      },
    );
    assert.equal(
      claudeEnv.CLAUDE_CONFIG_DIR,
      join(dataDir, 'sandbox', 'config', 'claude'),
    );
    assert.equal(claudeEnv.HOME, join(dataDir, 'sandbox', 'agent-home'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spawnEnvForAgent keeps sandbox roots pinned to the base OD_DATA_DIR', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'od-agent-env-sandbox-base-'));
  try {
    const env = spawnEnvForAgent(
      'claude',
      {
        OD_DATA_DIR: dataDir,
        OD_SANDBOX_MODE: '1',
        PATH: '/usr/bin',
      },
      {
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-host',
        OD_DATA_DIR: '/host/path/.od',
      },
    );

    assert.equal(env.OD_DATA_DIR, dataDir);
    assert.equal(env.CLAUDE_CONFIG_DIR, join(dataDir, 'sandbox', 'config', 'claude'));
    assert.equal(env.HOME, join(dataDir, 'sandbox', 'agent-home'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spawnEnvForAgent resolves relative OD_DATA_DIR before applying sandbox roots', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'od-agent-env-sandbox-relative-'));
  try {
    const relativeDataDir = relative(repoRoot, dataDir);
    const env = spawnEnvForAgent(
      'claude',
      {
        OD_DATA_DIR: relativeDataDir,
        OD_SANDBOX_MODE: '1',
        PATH: '/usr/bin',
      },
      {
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-host',
      },
    );

    assert.equal(env.CLAUDE_CONFIG_DIR, join(dataDir, 'sandbox', 'config', 'claude'));
    assert.equal(env.HOME, join(dataDir, 'sandbox', 'agent-home'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spawnEnvForAgent applies system proxy env to all agent runtimes before base env overrides', () => {
  const env = spawnEnvForAgent(
    'copilot',
    {
      HTTPS_PROXY: 'http://user-env:9000',
      PATH: '/usr/bin',
    },
    {},
    {
      HTTP_PROXY: 'http://system-http:7890',
      HTTPS_PROXY: 'http://system-https:7891',
      ALL_PROXY: 'socks5://system-socks:1080',
      NO_PROXY: '.local,localhost',
      NODE_USE_ENV_PROXY: '1',
    },
  );

  assert.equal(env.HTTP_PROXY, 'http://system-http:7890');
  assert.equal(env.HTTPS_PROXY, 'http://user-env:9000');
  assert.equal(env.ALL_PROXY, 'socks5://system-socks:1080');
  assert.equal(env.NO_PROXY, '.local,localhost');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.PATH, '/usr/bin');
});

test('spawnEnvForAgent resolves system proxy env for each default agent launch', () => {
  const proxySpy = vi.spyOn(platform, 'resolveSystemProxyEnv').mockReturnValue({
    HTTPS_PROXY: 'http://system-https:7891',
    NODE_USE_ENV_PROXY: '1',
  });

  try {
    const env = spawnEnvForAgent('copilot', { PATH: '/usr/bin' });

    assert.deepEqual(proxySpy.mock.calls, [[]]);
    assert.equal(env.HTTPS_PROXY, 'http://system-https:7891');
    assert.equal(env.PATH, '/usr/bin');
  } finally {
    proxySpy.mockRestore();
  }
});

test('spawnEnvForAgent lets explicit lowercase proxy env override system uppercase proxy env', () => {
  const env = spawnEnvForAgent(
    'copilot',
    {
      https_proxy: 'http://user-lowercase:9000',
      PATH: '/usr/bin',
    },
    {},
    {
      HTTPS_PROXY: 'http://system-uppercase:7891',
      NODE_USE_ENV_PROXY: '1',
    },
  );

  assert.equal(env.HTTPS_PROXY, 'http://user-lowercase:9000');
  if (process.platform !== 'win32') {
    assert.equal(env.https_proxy, 'http://user-lowercase:9000');
  }
});

test('spawnEnvForAgent enables Node env proxy support for inherited lowercase proxy env', () => {
  const env = spawnEnvForAgent(
    'copilot',
    {
      http_proxy: 'http://user-lowercase:9000',
      PATH: '/usr/bin',
    },
    {},
    {},
  );

  assert.equal(env.HTTP_PROXY, 'http://user-lowercase:9000');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  if (process.platform !== 'win32') {
    assert.equal(env.http_proxy, 'http://user-lowercase:9000');
  }
});

test('spawnEnvForAgent expands configured env home paths', () => {
  const env = spawnEnvForAgent('claude', { PATH: '/usr/bin' }, {
    CLAUDE_CONFIG_DIR: '~/.claude-alt',
    CLAUDE_BIN: '~',
  });

  assert.equal(env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude-alt'));
  assert.equal(env.CLAUDE_BIN, homedir());
  assert.equal(env.PATH, '/usr/bin');
});

test('resolveAgentExecutable prefers a configured CLAUDE_BIN override over PATH resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-claude-bin-'));
  try {
    return withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], () => {
      const isWin = process.platform === 'win32';
      const configured = join(dir, isWin ? 'claude-custom.cmd' : 'claude-custom');
      if (isWin) {
        writeFileSync(configured, '@echo off\r\nexit /b 0\r\n');
      } else {
        writeFileSync(configured, '#!/bin/sh\nexit 0\n');
        chmodSync(configured, 0o755);
      }
      process.env.PATH = '';
      process.env.OD_AGENT_HOME = dir;

      const resolved = resolveAgentExecutable(
        minimalAgentDef({ id: 'claude', bin: 'claude' }),
        { CLAUDE_BIN: configured },
      );

      assert.equal(resolved, configured);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectAgentExecutableResolution reports configured and PATH Claude binaries separately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-claude-bin-inspect-'));
  try {
    return withEnvSnapshot(['PATH', 'PATHEXT', 'OD_AGENT_HOME'], () => {
      const isWin = process.platform === 'win32';
      // On Windows the PATH resolver reconstructs the resolved path as
      // basename + a PATHEXT entry, so the fallback file's extension casing
      // must match a pinned PATHEXT entry for pathResolvedPath to compare equal.
      const configured = join(dir, isWin ? 'claude-custom.CMD' : 'claude-custom');
      const fallback = join(dir, isWin ? 'claude.CMD' : 'claude');
      if (isWin) {
        writeFileSync(configured, '@echo off\r\nexit /b 0\r\n');
        writeFileSync(fallback, '@echo off\r\nexit /b 0\r\n');
        process.env.PATHEXT = '.EXE;.CMD;.BAT';
      } else {
        writeFileSync(configured, '#!/bin/sh\nexit 0\n');
        writeFileSync(fallback, '#!/bin/sh\nexit 0\n');
        chmodSync(configured, 0o755);
        chmodSync(fallback, 0o755);
      }
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      const resolution = inspectAgentExecutableResolution(
        minimalAgentDef({ id: 'claude', bin: 'claude' }),
        { CLAUDE_BIN: configured },
      );

      assert.deepEqual(resolution, {
        configuredOverridePath: configured,
        pathResolvedPath: fallback,
        selectedPath: configured,
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable supports configured binary overrides per adapter', () => {
  const cases: Array<[string, string, string]> = [
    ['claude', 'claude', 'CLAUDE_BIN'],
    ['copilot', 'copilot', 'COPILOT_BIN'],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-bin-overrides-'));
  try {
    return withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], () => {
      process.env.PATH = '';
      process.env.OD_AGENT_HOME = dir;

      const isWin = process.platform === 'win32';
      for (const [id, binName, envKey] of cases) {
        const configured = join(dir, isWin ? `${binName}-custom.cmd` : `${binName}-custom`);
        if (isWin) {
          writeFileSync(configured, '@echo off\r\nexit /b 0\r\n');
        } else {
          writeFileSync(configured, '#!/bin/sh\nexit 0\n');
          chmodSync(configured, 0o755);
        }

        const resolved = resolveAgentExecutable(
          minimalAgentDef({ id, bin: binName }),
          { [envKey]: configured },
        );

        assert.equal(resolved, configured, `expected ${id} to use ${envKey}`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable ignores relative CLAUDE_BIN overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-claude-bin-rel-'));
  const oldCwd = process.cwd();
  try {
    return withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], () => {
      const configured = 'claude-custom';
      writeFileSync(join(dir, configured), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, configured), 0o755);
      process.chdir(dir);
      process.env.PATH = '';
      process.env.OD_AGENT_HOME = dir;

      const resolved = resolveAgentExecutable(
        minimalAgentDef({ id: 'claude', bin: 'claude' }),
        { CLAUDE_BIN: configured },
      );

      assert.equal(resolved, null);
    });
  } finally {
    process.chdir(oldCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable ignores configured binary overrides that are not executable files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-bin-invalid-'));
  try {
    return withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], () => {
      const directoryOverride = join(dir, 'as-directory');
      mkdirSync(directoryOverride);
      const fileOverride = join(dir, 'not-executable');
      writeFileSync(fileOverride, '#!/bin/sh\nexit 0\n');
      if (process.platform !== 'win32') chmodSync(fileOverride, 0o644);
      process.env.PATH = '';
      process.env.OD_AGENT_HOME = dir;

      assert.equal(
        resolveAgentExecutable(minimalAgentDef({ id: 'claude', bin: 'claude' }), { CLAUDE_BIN: directoryOverride }),
        null,
      );
      if (process.platform !== 'win32') {
        assert.equal(
          resolveAgentExecutable(minimalAgentDef({ id: 'claude', bin: 'claude' }), { CLAUDE_BIN: fileOverride }),
          null,
        );
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable ignores Windows CLAUDE_BIN overrides without executable PATHEXT extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-bin-win-invalid-'));
  try {
    return withEnvSnapshot(['PATH', 'PATHEXT', 'OD_AGENT_HOME'], () => {
      const invalidOverride = join(dir, 'claude-custom.txt');
      const fallback = join(dir, 'claude.CMD');
      writeFileSync(invalidOverride, '@echo off\r\nexit /b 0\r\n');
      writeFileSync(fallback, '@echo off\r\nexit /b 0\r\n');
      process.env.PATH = dir;
      process.env.PATHEXT = '.EXE;.CMD;.BAT';
      process.env.OD_AGENT_HOME = dir;

      const resolved = withPlatform('win32', () =>
        resolveAgentExecutable(
          minimalAgentDef({ id: 'claude', bin: 'claude' }),
          { CLAUDE_BIN: invalidOverride },
        ),
      );

      assert.equal(resolved, fallback);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentExecutable accepts Windows CLAUDE_BIN overrides with executable PATHEXT extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-bin-win-valid-'));
  try {
    return withEnvSnapshot(['PATH', 'PATHEXT', 'OD_AGENT_HOME'], () => {
      const configured = join(dir, 'claude-custom.CMD');
      writeFileSync(configured, '@echo off\r\nexit /b 0\r\n');
      process.env.PATH = '';
      process.env.PATHEXT = '.EXE;.CMD;.BAT';
      process.env.OD_AGENT_HOME = dir;

      const resolved = withPlatform('win32', () =>
        resolveAgentExecutable(
          minimalAgentDef({ id: 'claude', bin: 'claude' }),
          { CLAUDE_BIN: configured },
        ),
      );

      assert.equal(resolved, configured);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectAgents applies configured env while probing the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-agent-env-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      const bin = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      if (process.platform === 'win32') {
        writeFileSync(
          bin,
          '@echo off\r\nif "%~1"=="--version" (\r\n  echo %CLAUDE_CONFIG_DIR%\r\n  exit /b 0\r\n)\r\nif "%~1"=="-p" (\r\n  echo --add-dir --include-partial-messages\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n',
        );
      } else {
        writeFileSync(
          bin,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "$CLAUDE_CONFIG_DIR"; exit 0; fi\nif [ "$1" = "-p" ]; then echo "--add-dir --include-partial-messages"; exit 0; fi\nexit 0\n',
        );
        chmodSync(bin, 0o755);
      }
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      const agents = await detectAgents({
        claude: { CLAUDE_CONFIG_DIR: '/tmp/claude-config-probe' },
      });

      const detected = agents.find((agent) => agent.id === 'claude');
      assert.equal(detected?.available, true);
      assert.equal(detected?.version, '/tmp/claude-config-probe');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnEnvForAgent strips Anthropic credentials when claude resolves to OpenClaude fallback', () => {
  const env = spawnEnvForAgent(
    'claude',
    {
      ANTHROPIC_API_KEY: 'sk-openclaude',
      ANTHROPIC_AUTH_TOKEN: 'sk-token-openclaude',
      PATH: '/usr/bin',
    },
    {},
    {},
    { resolvedBin: '/tools/openclaude' },
  );

  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('spawnEnvForAgent strips Anthropic credentials for every adapter', () => {
  for (const agentId of ['claude', 'copilot']) {
    const env = spawnEnvForAgent(agentId, {
      ANTHROPIC_API_KEY: 'sk-strip',
      ANTHROPIC_AUTH_TOKEN: 'sk-token-strip',
      PATH: '/usr/bin',
    });
    assert.equal(
      'ANTHROPIC_API_KEY' in env,
      false,
      `expected ${agentId} to strip ANTHROPIC_API_KEY`,
    );
    assert.equal(
      'ANTHROPIC_AUTH_TOKEN' in env,
      false,
      `expected ${agentId} to strip ANTHROPIC_AUTH_TOKEN`,
    );
  }
});

test('spawnEnvForAgent strips Anthropic API credentials but preserves ANTHROPIC_BASE_URL', () => {
  const env = spawnEnvForAgent('claude', {
    ANTHROPIC_API_KEY: 'sk-kimi',
    ANTHROPIC_AUTH_TOKEN: 'sk-token',
    ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/v1',
    PATH: '/usr/bin',
  });

  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.moonshot.cn/v1');
  assert.equal(env.PATH, '/usr/bin');
});

test('spawnEnvForAgent does not mutate the input env', () => {
  const original = { ANTHROPIC_API_KEY: 'sk-leak', PATH: '/usr/bin' };
  const env = spawnEnvForAgent('claude', original);

  assert.equal(original.ANTHROPIC_API_KEY, 'sk-leak');
  assert.notEqual(env, original);
});
