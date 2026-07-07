import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentRefreshOptionsForConfig,
  deriveAboutUpdateControl,
  configForManualOrbitRun,
  isOrbitRunDisabled,
  shouldShowCustomModelInput,
  persistConfigAndRunOrbit,
  updateAgentCliEnvValue,
} from '../../src/components/SettingsDialog';
import { deriveUpdaterModel } from '../../src/lib/updater';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';
import type { AppConfig, AppVersionInfo } from '../../src/types';

const originalFetch = globalThis.fetch;

const baseConfig: AppConfig = {
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const packagedVersion: AppVersionInfo = {
  arch: 'arm64',
  channel: 'beta',
  packaged: true,
  platform: 'darwin',
  version: '1.2.3-beta.3',
};

function updateStatus(
  overrides: Partial<OpenDesignHostUpdaterStatusSnapshot> = {},
): OpenDesignHostUpdaterStatusSnapshot {
  return {
    arch: 'arm64',
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: 'beta',
    currentVersion: '1.2.3-beta.3',
    enabled: true,
    mode: 'package-launcher',
    platform: 'darwin',
    state: 'idle',
    supported: true,
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SettingsDialog about update control', () => {
  it('shows a check action before updates have been checked', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(updateStatus(), { hostAvailable: true }),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: 'check',
      primaryLabelKey: 'settings.updateCheck',
      statusKey: 'settings.updateStatusNotChecked',
    });
  });

  it('shows up-to-date status without turning the primary action into a release link', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(updateStatus({ state: 'not-available' }), { hostAvailable: true }),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: 'check',
      primaryLabelKey: 'settings.updateRecheck',
      showReleaseLink: true,
      statusKey: 'settings.updateStatusUpToDate',
      statusTone: 'success',
    });
  });

  it('offers download when an update is available', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(
        updateStatus({
          availableVersion: '1.2.3-beta.4',
          state: 'available',
        }),
        { hostAvailable: true },
      ),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: 'download',
      primaryLabelKey: 'updater.download',
      statusKey: 'settings.updateStatusAvailable',
      statusVars: { version: '1.2.3-beta.4' },
    });
  });

  it('disables the primary action while downloading and keeps progress visible', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(
        updateStatus({
          incoming: {
            arch: 'arm64',
            artifact: {
              name: 'Open Design Beta.dmg',
              platformKey: 'macAppleSilicon',
              type: 'dmg',
              url: 'https://fixture.test/Open Design Beta.dmg',
            },
            channel: 'beta',
            progress: {
              receivedBytes: 25,
              totalBytes: 100,
            },
            startedAt: '2026-06-16T00:00:00.000Z',
            version: '1.2.3-beta.4',
          },
          state: 'downloading',
        }),
        { hostAvailable: true },
      ),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: null,
      primaryLabelKey: 'updater.downloading',
      statusKey: 'settings.updateStatusDownloadingPercent',
      statusVars: { percent: 25 },
    });
  });

  it('offers install when an update has already downloaded', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(
        updateStatus({
          artifact: {
            name: 'Open Design Beta.dmg',
            platformKey: 'macAppleSilicon',
            type: 'dmg',
            url: 'https://fixture.test/Open Design Beta.dmg',
          },
          availableVersion: '1.2.3-beta.4',
          downloadPath: '/tmp/Open Design Beta.dmg',
          state: 'downloaded',
        }),
        { hostAvailable: true },
      ),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: 'install',
      primaryLabelKey: 'settings.updateNow',
      statusKey: 'settings.updateStatusReady',
      statusVars: { version: '1.2.3-beta.4' },
    });
  });

  it('offers install and restart when a payload update has already downloaded', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(
        updateStatus({
          artifact: {
            name: 'open-design-1.2.3-beta.4-mac-arm64-payload.zip',
            platformKey: 'mac',
            type: 'payload',
            url: 'https://fixture.test/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
          },
          availableVersion: '1.2.3-beta.4',
          capabilities: {
            canApplyInPlace: true,
            canDownload: true,
            canOpenInstaller: false,
            requiresManualInstall: false,
          },
          downloadPath: '/tmp/open-design-updater/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
          state: 'downloaded',
        }),
        { hostAvailable: true },
      ),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: 'install',
      primaryLabelKey: 'updater.installRestart',
      statusKey: 'settings.updateStatusReady',
      statusVars: { version: '1.2.3-beta.4' },
    });
  });

  it('offers a quit retry after the installer has opened', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(
        updateStatus({
          artifact: {
            name: 'Open Design Beta.dmg',
            platformKey: 'macAppleSilicon',
            type: 'dmg',
            url: 'https://fixture.test/Open Design Beta.dmg',
          },
          availableVersion: '1.2.3-beta.4',
          downloadPath: '/tmp/Open Design Beta.dmg',
          installResult: {
            dryRun: true,
            openedAt: '2026-05-19T00:00:00.000Z',
            path: '/tmp/Open Design Beta.dmg',
          },
          state: 'downloaded',
        }),
        { hostAvailable: true },
      ),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: 'quit',
      primaryLabelKey: 'updater.quitButton',
      showReleaseLink: false,
      statusKey: 'settings.updateQuitFailed',
      statusTone: 'warning',
    });
  });

  it('turns update errors into a retry action', () => {
    const control = deriveAboutUpdateControl(
      deriveUpdaterModel(updateStatus({ state: 'error' }), { hostAvailable: true }),
      packagedVersion,
    );

    expect(control).toMatchObject({
      primaryAction: 'check',
      primaryLabelKey: 'settings.updateRetry',
      statusKey: 'settings.updateStatusFailed',
      statusTone: 'error',
    });
  });

  it('does not offer in-app update actions in development or web-only contexts', () => {
    const developmentControl = deriveAboutUpdateControl(
      deriveUpdaterModel(updateStatus(), { hostAvailable: true }),
      { ...packagedVersion, packaged: false },
    );
    const webControl = deriveAboutUpdateControl(
      deriveUpdaterModel(null, { hostAvailable: false }),
      packagedVersion,
    );

    expect(developmentControl).toMatchObject({
      primaryAction: null,
      statusKey: 'settings.updateStatusDevelopment',
    });
    expect(webControl).toMatchObject({
      primaryAction: null,
      statusKey: 'settings.updateStatusUnsupported',
    });
  });
});

describe('SettingsDialog custom model picker state', () => {
  it('keeps custom input visible while an intermediate value matches a known model', () => {
    expect(
      shouldShowCustomModelInput('gpt-5', ['gpt-5', 'o3'], true),
    ).toBe(true);
  });

  it('uses the dropdown when a known model is selected outside custom mode', () => {
    expect(
      shouldShowCustomModelInput('gpt-5', ['gpt-5', 'o3'], false),
    ).toBe(false);
  });

  it('shows custom input for unknown or empty model values', () => {
    expect(
      shouldShowCustomModelInput('gpt-5.5', ['gpt-5', 'o3'], false),
    ).toBe(true);
    expect(shouldShowCustomModelInput('', ['gpt-5', 'o3'], false)).toBe(true);
  });
});

describe('SettingsDialog agent CLI env settings', () => {
  it('updates supported per-agent CLI env values without dropping sibling agents', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'CLAUDE_CONFIG_DIR',
      '  ~/.claude-2  ',
    );

    expect(next.agentCliEnv).toEqual({
      claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
      codex: { CODEX_HOME: '~/.codex-alt' },
    });
  });

  it('updates additional Codex CLI env values without dropping sibling Codex fields', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'codex',
      'CODEX_BIN',
      '  ~/bin/codex-next  ',
    );

    expect(next.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-alt', CODEX_BIN: '~/bin/codex-next' },
    });
    expect(next.agentCliEnvIntent).toEqual({});
  });

  it('marks API key env values as explicit CLI overrides', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'ANTHROPIC_API_KEY',
      '  sk-anthropic  ',
    );

    expect(next.agentCliEnv).toEqual({
      claude: { CLAUDE_CONFIG_DIR: '~/.claude-alt', ANTHROPIC_API_KEY: 'sk-anthropic' },
    });
    expect(next.agentCliEnvIntent).toEqual({
      claude: { apiKeyOverride: true },
    });
  });

  it('keeps the API key override marker when clearing a base URL with a key present', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: {
          ANTHROPIC_API_KEY: 'sk-anthropic',
          ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
        },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'ANTHROPIC_BASE_URL',
      '',
    );

    expect(next.agentCliEnv).toEqual({
      claude: { ANTHROPIC_API_KEY: 'sk-anthropic' },
    });
    expect(next.agentCliEnvIntent).toEqual({
      claude: { apiKeyOverride: true },
    });
  });

  it('removes the API key override marker when the last auth key is cleared', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: {
          CLAUDE_CONFIG_DIR: '~/.claude-2',
          ANTHROPIC_API_KEY: 'sk-anthropic',
        },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'ANTHROPIC_API_KEY',
      '',
    );

    expect(next.agentCliEnv).toEqual({
      claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
    });
    expect(next.agentCliEnvIntent).toEqual({});
  });

  it('removes empty per-agent CLI env entries', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'CLAUDE_CONFIG_DIR',
      '',
    );

    expect(next.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-alt' },
    });
  });

  it('passes pending CLI env prefs through agent rescan options', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-pending' },
      },
    };

    expect(agentRefreshOptionsForConfig(config)).toEqual({
      throwOnError: true,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-pending' },
      },
    });
  });

  it('passes an empty CLI env object through agent rescan after fields are cleared', () => {
    const config: AppConfig = {
      ...baseConfig,
      agentCliEnv: {},
    };

    expect(agentRefreshOptionsForConfig(config)).toEqual({
      throwOnError: true,
      agentCliEnv: {},
    });
  });
});

describe('SettingsDialog Orbit run behavior', () => {
  it('keeps manual Orbit runs disabled while connector availability is still loading', () => {
    expect(isOrbitRunDisabled(false, null)).toBe(true);
  });

  it('allows manual Orbit runs once loading finishes and a connector is available', () => {
    expect(isOrbitRunDisabled(false, 1)).toBe(false);
  });

  it('persists the current orbit template config before starting the run', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });

      if (url === '/api/app-config') {
        return new Response(null, { status: 204 });
      }
      if (url === '/api/orbit/run') {
        return new Response(JSON.stringify({ projectId: 'orbit-project', agentRunId: 'run-1' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(
      persistConfigAndRunOrbit({
        ...baseConfig,
        orbit: {
          enabled: true,
          time: '09:30',
          templateSkillId: 'orbit-template-1',
        },
      }),
    ).resolves.toEqual({ projectId: 'orbit-project', agentRunId: 'run-1' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: '/api/app-config',
      method: 'PUT',
    });
    expect(JSON.parse(calls[0]!.body ?? '{}')).toMatchObject({
      orbit: {
        enabled: true,
        time: '09:30',
        templateSkillId: 'orbit-template-1',
      },
    });
    expect(calls[1]).toMatchObject({
      url: '/api/orbit/run',
      method: 'POST',
    });
    expect(JSON.parse(calls[1]!.body ?? '{}')).toEqual({ locale: null });
  });

  it('does not start a manual Orbit run when saving app config fails', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === '/api/app-config') {
        return new Response(null, { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(
      persistConfigAndRunOrbit({
        ...baseConfig,
      }),
    ).rejects.toThrow('Failed to sync app config (500)');

    expect(calls).toEqual(['/api/app-config']);
  });

  it('passes the selected UI locale through to the manual Orbit run', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });

      if (url === '/api/app-config') {
        return new Response(null, { status: 204 });
      }
      if (url === '/api/orbit/run') {
        return new Response(JSON.stringify({ projectId: 'orbit-project', agentRunId: 'run-zh' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(
      persistConfigAndRunOrbit(baseConfig, { locale: 'zh-CN' }),
    ).resolves.toEqual({ projectId: 'orbit-project', agentRunId: 'run-zh' });

    expect(JSON.parse(calls[1]!.body ?? '{}')).toEqual({ locale: 'zh-CN' });
  });

  it('persists the displayed default template before starting a legacy null-template run', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });

      if (url === '/api/app-config') {
        return new Response(null, { status: 204 });
      }
      if (url === '/api/orbit/run') {
        return new Response(JSON.stringify({ projectId: 'orbit-project', agentRunId: 'run-2' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(
      persistConfigAndRunOrbit(configForManualOrbitRun({
        ...baseConfig,
        orbit: {
          enabled: true,
          time: '09:30',
          templateSkillId: null,
        },
      })),
    ).resolves.toEqual({ projectId: 'orbit-project', agentRunId: 'run-2' });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body ?? '{}')).toMatchObject({
      orbit: {
        enabled: true,
        time: '09:30',
        templateSkillId: 'orbit-general',
      },
    });
    expect(calls[1]).toMatchObject({
      url: '/api/orbit/run',
      method: 'POST',
    });
  });
});
