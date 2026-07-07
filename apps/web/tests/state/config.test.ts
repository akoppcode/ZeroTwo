import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncConfigToDaemon,
} from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const store = new Map<string, string>();
const originalFetch = globalThis.fetch;

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    store.delete(key);
  }),
  clear: vi.fn(() => {
    store.clear();
  }),
});

describe('syncConfigToDaemon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', originalFetch);
  });

  it('syncs per-agent CLI env prefs to the daemon app config', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        copilot: { COPILOT_HOME: '~/.copilot-alt' },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/app-config');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      onboardingCompleted: DEFAULT_CONFIG.onboardingCompleted,
      agentId: DEFAULT_CONFIG.agentId,
      agentModels: DEFAULT_CONFIG.agentModels,
      skillId: DEFAULT_CONFIG.skillId,
      designSystemId: DEFAULT_CONFIG.designSystemId,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        copilot: { COPILOT_HOME: '~/.copilot-alt' },
      },
    });
  });

  it('syncs CLI API key env values and intent to daemon app config while localStorage strips them', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: { ANTHROPIC_API_KEY: 'sk-anthropic', ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic' },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      agentCliEnv: {
        claude: { ANTHROPIC_API_KEY: 'sk-anthropic', ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic' },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
      },
    });
  });

  it('syncs daemon-owned privacy decision fields', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true, content: true, artifactManifest: false },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true, content: true, artifactManifest: false },
    });
  });
});

describe('mergeDaemonConfig', () => {
  it('clears stale local CLI env prefs when the daemon has none', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnv: {
          claude: { CLAUDE_CONFIG_DIR: '~/.claude-old' },
        },
      },
      {
        agentId: 'copilot',
      },
    );

    expect(merged.agentId).toBe('copilot');
    expect(merged.agentCliEnv).toEqual({});
  });

  it('uses daemon CLI env prefs instead of merging with stale local entries', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnv: {
          claude: { CLAUDE_CONFIG_DIR: '~/.claude-old' },
        },
      },
      {
        agentCliEnv: {
          copilot: { COPILOT_HOME: '~/.copilot-new' },
        },
      },
    );

    expect(merged.agentCliEnv).toEqual({
      copilot: { COPILOT_HOME: '~/.copilot-new' },
    });
  });

  it('uses daemon CLI env intent instead of merging with stale local entries', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnvIntent: {
          claude: { apiKeyOverride: true },
        },
      },
      {
        agentCliEnvIntent: {
          copilot: { apiKeyOverride: true },
        },
      },
    );

    expect(merged.agentCliEnvIntent).toEqual({
      copilot: { apiKeyOverride: true },
    });
  });

  it('copies privacyDecisionAt from daemon config', () => {
    const merged = mergeDaemonConfig(DEFAULT_CONFIG, {
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true },
    });

    expect(merged.installationId).toBe('install-1');
    expect(merged.privacyDecisionAt).toBe(1778244000000);
    expect(merged.telemetry).toEqual({ metrics: true });
  });

  it('migrates old daemon privacy config to a resolved decision', () => {
    const merged = mergeDaemonConfig(DEFAULT_CONFIG, {
      installationId: 'install-1',
      telemetry: { metrics: true },
    });

    expect(merged.installationId).toBe('install-1');
    expect(typeof merged.privacyDecisionAt).toBe('number');
  });

  it('defaults reporting on and mints an installationId when the install never opted out', () => {
    // Brand-new install: the daemon has no privacy state at all. The product
    // default telemetry channels (metrics + content) are on and an anonymous
    // id is assigned so events have a stable distinct id. This mirrors the
    // first-run banner's "I get it" opt-in payload; artifactManifest stays
    // off, matching that surface.
    const merged = mergeDaemonConfig(DEFAULT_CONFIG, {});

    expect(merged.telemetry?.metrics).toBe(true);
    expect(merged.telemetry?.content).toBe(true);
    expect(merged.telemetry?.artifactManifest).toBe(false);
    expect(typeof merged.installationId).toBe('string');
    expect(merged.installationId).toBeTruthy();
  });

  it('mints an installationId for a reporting install that somehow has none', () => {
    // The "on but no id" state that surfaces as "Opted out" in Settings:
    // metrics is on but no anonymous id was ever assigned.
    const merged = mergeDaemonConfig(DEFAULT_CONFIG, {
      telemetry: { metrics: true, content: false, artifactManifest: false },
      installationId: null,
    });

    expect(merged.telemetry?.metrics).toBe(true);
    expect(merged.installationId).toBeTruthy();
  });

  it('preserves an explicit opt-out and never re-mints an id', () => {
    const merged = mergeDaemonConfig(DEFAULT_CONFIG, {
      telemetry: { metrics: false, content: false, artifactManifest: false },
      installationId: null,
      privacyDecisionAt: 1778244000000,
    });

    expect(merged.telemetry?.metrics).toBe(false);
    expect(merged.installationId == null).toBe(true);
  });
});

afterEach(() => {
  store.clear();
});

describe('loadConfig', () => {
  it('preserves a valid saved accent color', () => {
    const savedConfig: Partial<AppConfig> = {
      theme: 'dark',
      accentColor: '#4F46E5',
    };
    store.set('open-design:config', JSON.stringify(savedConfig));

    const config = loadConfig();

    expect(config.theme).toBe('dark');
    expect(config.accentColor).toBe('#4f46e5');
  });

  it('falls back to the default accent color for malformed saved colors', () => {
    const savedConfig: Partial<AppConfig> = {
      accentColor: 'blue',
    };
    store.set('open-design:config', JSON.stringify(savedConfig));

    expect(loadConfig().accentColor).toBe(DEFAULT_CONFIG.accentColor);
  });

  it('falls back to the default Orbit time for out-of-range saved times', () => {
    const savedConfig: Partial<AppConfig> = {
      orbit: {
        enabled: true,
        time: '99:99',
        templateSkillId: 'orbit-general',
      },
    };
    store.set('open-design:config', JSON.stringify(savedConfig));

    expect(loadConfig().orbit?.time).toBe(DEFAULT_CONFIG.orbit?.time);
  });

  it('returns defaults for malformed localStorage JSON', () => {
    store.set('open-design:config', '{broken-json');

    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('stamps the current migration version and accent color on default configs', () => {
    expect(DEFAULT_CONFIG.configMigrationVersion).toBe(1);
    expect(DEFAULT_CONFIG.accentColor).toBe('#c96442');
  });
});

describe('saveConfig', () => {
  it('keeps daemon-owned privacy fields out of localStorage', () => {
    saveConfig({
      ...DEFAULT_CONFIG,
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true },
    });

    const saved = JSON.parse(store.get('open-design:config') ?? '{}');
    expect(saved.installationId).toBeUndefined();
    expect(saved.privacyDecisionAt).toBeUndefined();
    expect(saved.telemetry).toBeUndefined();
  });

  it('keeps CLI API key env values out of localStorage while preserving intent and non-secret env', () => {
    saveConfig({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: {
          ANTHROPIC_API_KEY: 'sk-anthropic',
          ANTHROPIC_AUTH_TOKEN: 'sk-auth-token',
          ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
          CLAUDE_CONFIG_DIR: '~/.claude-2',
        },
      },
      agentCliEnvIntent: {
        claude: { apiKeyOverride: true },
      },
    });

    const saved = JSON.parse(store.get('open-design:config') ?? '{}');
    expect(saved.agentCliEnv.claude).toEqual({
      ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
      CLAUDE_CONFIG_DIR: '~/.claude-2',
    });
    expect(saved.agentCliEnvIntent).toEqual({
      claude: { apiKeyOverride: true },
    });
  });
});
