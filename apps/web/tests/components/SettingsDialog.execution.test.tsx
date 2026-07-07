// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { en } from '../../src/i18n/locales/en';

function optionNames(container: HTMLElement): string[] {
  return within(container).getAllByRole('option').map((option) => {
    const labelledBy = option.getAttribute('aria-labelledby');
    if (!labelledBy) return option.textContent?.trim() ?? '';
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
  });
}

const {
  playSoundMock,
  requestNotificationPermissionMock,
  showCompletionNotificationMock,
  notificationPermissionMock,
  fetchCodexPetsMock,
  syncCommunityPetsMock,
  fetchSkillsMock,
  fetchDesignSystemsMock,
  fetchSkillMock,
  fetchDesignSystemMock,
  importLocalDesignSystemMock,
  importGitHubDesignSystemMock,
  fetchLatestGithubReleaseInfoMock,
  openExternalUrlMock,
  analyticsTrackMock,
} = vi.hoisted(() => ({
  playSoundMock: vi.fn(),
  requestNotificationPermissionMock: vi.fn(),
  showCompletionNotificationMock: vi.fn(),
  notificationPermissionMock: vi.fn(),
  fetchCodexPetsMock: vi.fn(),
  syncCommunityPetsMock: vi.fn(),
  fetchSkillsMock: vi.fn(),
  fetchDesignSystemsMock: vi.fn(),
  fetchSkillMock: vi.fn(),
  fetchDesignSystemMock: vi.fn(),
  importLocalDesignSystemMock: vi.fn(),
  importGitHubDesignSystemMock: vi.fn(),
  fetchLatestGithubReleaseInfoMock: vi.fn(),
  openExternalUrlMock: vi.fn(),
  analyticsTrackMock: vi.fn(),
}));

vi.mock('../../src/utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/notifications')>(
    '../../src/utils/notifications',
  );
  return {
    ...actual,
    playSound: playSoundMock,
    requestNotificationPermission: requestNotificationPermissionMock,
    showCompletionNotification: showCompletionNotificationMock,
    notificationPermission: notificationPermissionMock,
  };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchCodexPets: fetchCodexPetsMock,
    syncCommunityPets: syncCommunityPetsMock,
    fetchSkills: fetchSkillsMock,
    fetchDesignSystems: fetchDesignSystemsMock,
    fetchSkill: fetchSkillMock,
    fetchDesignSystem: fetchDesignSystemMock,
    importLocalDesignSystem: importLocalDesignSystemMock,
    importGitHubDesignSystem: importGitHubDesignSystemMock,
    fetchLatestGithubReleaseInfo: fetchLatestGithubReleaseInfoMock,
    openExternalUrl: openExternalUrlMock,
    codexPetSpritesheetUrl: (pet: { spritesheetUrl: string }) => pet.spritesheetUrl,
  };
});

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analyticsTrackMock,
    setConsent: () => undefined,
    setIdentity: () => undefined,
    setConfigureGlobals: () => undefined,
    anonymousId: 'test-anonymous',
    sessionId: 'test-session',
    newRequestId: () => 'test-request',
  }),
}));

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { IntegrationsView } from '../../src/components/IntegrationsView';
import type { AgentRefreshOptions, SettingsSection } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { LOCALES } from '../../src/i18n/types';
import type { AgentInfo, AppConfig, AppVersionInfo } from '../../src/types';

const baseConfig: AppConfig = {
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

const availableAgents: AgentInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '2.1.196',
    models: [{ id: 'default', label: 'Default' }],
  },
];

type OnRefreshAgents = (
  options?: AgentRefreshOptions,
) => void | AgentInfo[] | Promise<void | AgentInfo[]>;

const sampleBundledPets = [
  {
    id: 'dario',
    displayName: 'Dario',
    description: 'A tiny frustrated companion.',
    spritesheetUrl: '/api/codex-pets/dario.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000000000,
    bundled: true,
  },
  {
    id: 'nyako',
    displayName: 'Nyako',
    description: 'A warm companion.',
    spritesheetUrl: '/api/codex-pets/nyako.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000001000,
    bundled: true,
  },
];

const sampleCommunityPets = [
  {
    id: 'jade',
    displayName: 'Jade',
    description: 'A cheerful explorer.',
    spritesheetUrl: '/api/codex-pets/jade.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000010000,
  },
  {
    id: 'voidling',
    displayName: 'Voidling',
    description: 'A tiny grim companion.',
    spritesheetUrl: '/api/codex-pets/voidling.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000020000,
  },
];

const sampleSkills = [
  {
    id: 'blog-post',
    name: 'blog-post',
    description: 'A long-form article / blog post.',
    mode: 'prototype',
    previewType: 'HTML',
  },
  {
    id: 'dashboard',
    name: 'dashboard',
    description: 'Admin / analytics dashboard.',
    mode: 'prototype',
    previewType: 'HTML',
  },
  {
    id: 'sales-deck',
    name: 'sales-deck',
    description: 'A narrative sales presentation.',
    mode: 'deck',
    previewType: 'PPTX',
  },
];

const sampleDesignSystems = [
  {
    id: 'neutral-modern',
    title: 'Neutral Modern',
    summary: 'Calm editorial neutrals.',
    category: 'Default',
    swatches: ['#111827', '#f5f5f4'],
  },
  {
    id: 'signal-green',
    title: 'Signal Green',
    summary: 'Brighter utility system.',
    category: 'Experimental',
    swatches: ['#14532d', '#86efac'],
  },
];

let restoreOpenDesignHost: (() => void) | null = null;

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

function renderSettingsDialog(
  initial: Partial<AppConfig> = {},
  options: {
    agents?: AgentInfo[];
    daemonLive?: boolean;
    onRefreshAgents?: OnRefreshAgents;
    initialSection?: SettingsSection;
    appVersionInfo?: AppVersionInfo | null;
    welcome?: boolean;
  } = {},
) {
  const onPersist = vi.fn();
  const onClose = vi.fn();
  const onRefreshAgents = options.onRefreshAgents ?? vi.fn<OnRefreshAgents>();

  const view = render(
    <SettingsDialog
      initial={{ ...baseConfig, ...initial }}
      agents={options.agents ?? availableAgents}
      daemonLive={options.daemonLive ?? true}
      appVersionInfo={options.appVersionInfo ?? null}
      initialSection={options.initialSection ?? 'execution'}
      welcome={options.welcome}
      onPersist={onPersist}
      onClose={onClose}
      onRefreshAgents={onRefreshAgents}
    />,
  );

  return { onPersist, onClose, onRefreshAgents, ...view };
}

function renderIntegrationsView(
  initial: Partial<AppConfig> = {},
  options: {
    initialTab?: 'mcp' | 'skills' | 'use-everywhere';
  } = {},
) {
  const onConfigPersist = vi.fn();
  const view = render(
    <IntegrationsView
      config={{ ...baseConfig, ...initial }}
      initialTab={options.initialTab ?? 'mcp'}
      onConfigPersist={onConfigPersist}
    />,
  );

  return { onConfigPersist, ...view };
}

function renderLanguageSettingsDialog(initialLocale: Parameters<typeof I18nProvider>[0]['initial'] = 'en') {
  const onPersist = vi.fn();
  const onClose = vi.fn();

  render(
    <I18nProvider initial={initialLocale}>
      <SettingsDialog
        initial={baseConfig}
        agents={availableAgents}
        daemonLive={true}
        appVersionInfo={null}
        initialSection="language"
        onPersist={onPersist}
        onClose={onClose}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );

  return { onPersist, onClose };
}

async function waitForPersist(
  onPersist: ReturnType<typeof vi.fn>,
  expectedConfig: unknown,
) {
  await waitFor(() => {
    expect(onPersist).toHaveBeenCalledWith(expectedConfig);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  playSoundMock.mockReset();
  requestNotificationPermissionMock.mockReset();
  showCompletionNotificationMock.mockReset();
  notificationPermissionMock.mockReset();
  fetchCodexPetsMock.mockReset();
  syncCommunityPetsMock.mockReset();
  fetchSkillsMock.mockReset();
  fetchDesignSystemsMock.mockReset();
  fetchSkillMock.mockReset();
  fetchDesignSystemMock.mockReset();
  importLocalDesignSystemMock.mockReset();
  importGitHubDesignSystemMock.mockReset();
  openExternalUrlMock.mockReset();
  analyticsTrackMock.mockReset();
  notificationPermissionMock.mockReturnValue('default');
  requestNotificationPermissionMock.mockResolvedValue('granted');
  showCompletionNotificationMock.mockResolvedValue('shown');
  fetchCodexPetsMock.mockResolvedValue({
    pets: [],
    rootDir: '/Users/test/.codex/pets',
  });
  syncCommunityPetsMock.mockResolvedValue({
    wrote: 0,
    skipped: 0,
    failed: 0,
    total: 0,
    rootDir: '/Users/test/.codex/pets',
    errors: [],
  });
  fetchSkillsMock.mockResolvedValue(sampleSkills);
  fetchDesignSystemsMock.mockResolvedValue(sampleDesignSystems);
  fetchSkillMock.mockImplementation(async (id: string) => ({
    id,
    body: `skill body for ${id}`,
  }));
  fetchDesignSystemMock.mockImplementation(async (id: string) => ({
    id,
    body: `design system body for ${id}`,
  }));
  fetchLatestGithubReleaseInfoMock.mockReset();
  fetchLatestGithubReleaseInfoMock.mockResolvedValue(null);
  openExternalUrlMock.mockResolvedValue(true);
  importLocalDesignSystemMock.mockResolvedValue({
    designSystem: {
      id: 'imported-system',
      title: 'Imported System',
      summary: 'A newly imported system.',
      category: 'Imported',
      swatches: ['#0f766e', '#ccfbf1'],
    },
  });
  importGitHubDesignSystemMock.mockResolvedValue({
    designSystem: {
      id: 'github-system',
      title: 'GitHub System',
      summary: 'A GitHub imported system.',
      category: 'Imported',
      swatches: ['#1d4ed8', '#bfdbfe'],
    },
  });
});

afterEach(() => {
  restoreOpenDesignHost?.();
  restoreOpenDesignHost = null;
});

describe('SettingsDialog execution settings Local CLI interactions', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('collapses the settings sidebar and toggles fullscreen from dialog chrome', () => {
    const { container } = renderSettingsDialog();
    const dialog = screen.getByRole('dialog');
    const sidebar = container.querySelector('#settings-sidebar');

    expect(dialog.classList.contains('settings-sidebar-collapsed')).toBe(false);
    expect(sidebar?.getAttribute('aria-hidden')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse settings sidebar' }));
    expect(dialog.classList.contains('settings-sidebar-collapsed')).toBe(true);
    expect(sidebar?.getAttribute('aria-hidden')).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'Expand settings sidebar' })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Expand settings sidebar' }));
    expect(dialog.classList.contains('settings-sidebar-collapsed')).toBe(false);
    expect(sidebar?.getAttribute('aria-hidden')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(dialog.classList.contains('settings-fullscreen')).toBe(true);
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    expect(dialog.classList.contains('settings-fullscreen')).toBe(false);
  });

  it('selects an installed agent and autosaves', async () => {
    const installed = availableAgents[0]!;
    const unavailable: AgentInfo = {
      id: 'copilot',
      name: 'GitHub Copilot CLI',
      bin: 'copilot',
      available: false,
      version: null,
      models: [],
      installUrl: 'https://github.com/github/copilot-cli',
      docsUrl: 'https://docs.github.com/en/copilot',
    };
    const { onPersist } = renderSettingsDialog(
      { agentId: null },
      { agents: [installed, unavailable] },
    );

    expect(screen.getByText('Your CLIs (1)')).toBeTruthy();
    const installGroupSummary = screen.getByText('Available to install (1)');
    expect(installGroupSummary.closest('details')?.hasAttribute('open')).toBe(false);
    const claudeCard = screen.getByRole('button', { name: /Claude Code/i }) as HTMLButtonElement;
    fireEvent.click(installGroupSummary);
    const copilotGroup = screen.getByRole('group', { name: /GitHub Copilot CLI/i });
    expect(within(copilotGroup).getByText('GitHub coding CLI')).toBeTruthy();
    expect(
      (within(copilotGroup).getByRole('link', { name: en['settings.agentInstall.install'] }) as HTMLAnchorElement).getAttribute('href'),
    ).toBe(
      'https://github.com/github/copilot-cli',
    );
    expect(
      screen.getByText(en['settings.agentInstall.stepAuth']),
    ).toBeTruthy();
    expect(
      screen.getByText(en['settings.agentInstall.stepSelect']),
    ).toBeTruthy();
    expect(screen.getByText(en['settings.agentInstall.pathHint'])).toBeTruthy();

    fireEvent.click(claudeCard);
    const selectedCard = claudeCard.closest('.agent-card') as HTMLElement;
    expect(
      within(selectedCard).getByRole('combobox', {
        name: en['settings.modelPicker'],
      }),
    ).toBeTruthy();
    expect(
      selectedCard.compareDocumentPosition(installGroupSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitForPersist(
      onPersist,
      expect.objectContaining({
        agentId: 'claude',
      }),
    );
  });

  it('filters long Local CLI model lists in Settings without hiding the current selection', () => {
    renderSettingsDialog(
      { agentId: 'claude', agentModels: { claude: { model: 'claude-haiku-3-5' } } },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'live',
            models: [
              { id: 'default', label: 'Default' },
              { id: 'claude-haiku-3-5', label: 'claude-haiku-3-5' },
              { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
              { id: 'claude-opus-4-1', label: 'claude-opus-4-1' },
              { id: 'claude-sonnet-4-0', label: 'claude-sonnet-4-0' },
              { id: 'claude-opus-4-0', label: 'claude-opus-4-0' },
              { id: 'claude-3-7-sonnet', label: 'claude-3-7-sonnet' },
              { id: 'claude-3-5-sonnet', label: 'claude-3-5-sonnet' },
            ],
          },
        ],
      },
    );

    const modelPicker = screen.getByRole('combobox', {
      name: en['settings.modelPicker'],
    });
    fireEvent.click(modelPicker);

    const searchInput = screen.getByTestId('settings-agent-model-search-claude') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'sonnet-4-5' } });

    const modelPopover = screen.getByTestId('settings-agent-model-popover-claude');
    expect(optionNames(modelPopover)).toEqual(['claude-haiku-3-5', 'claude-sonnet-4-5', 'Custom (type below)…']);
  });

  it('labels live CLI model metadata in the model picker', () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'live',
            models: [
              { id: 'default', label: 'Default' },
              { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
            ],
          },
        ],
      },
    );

    expect(screen.getByText('Live from CLI')).toBeTruthy();
    expect(
      screen.getByText(/Model list comes from this CLI/i),
    ).toBeTruthy();
  });

  it('labels fallback CLI model metadata in the model picker', () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'fallback',
          },
        ],
      },
    );

    expect(screen.getByText('Built-in list')).toBeTruthy();
    expect(
      screen.getByText(/Showing built-in defaults/i),
    ).toBeTruthy();
  });

  it('shows an empty state when no local CLI agents are detected', () => {
    renderSettingsDialog(
      { agentId: null },
      { agents: [] },
    );

    expect(screen.getByText(/No agents detected yet/i)).toBeTruthy();
  });

  it('labels the memory model default with the selected Local CLI', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/memory') {
        return new Response(
          JSON.stringify({ enabled: true, memories: [], extraction: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));

    renderSettingsDialog(
      { agentId: 'claude' },
      { agents: availableAgents },
    );

    const memoryModel = await screen.findByRole('combobox', { name: 'Memory model' });
    expect(memoryModel.textContent).toBe('Same as chat (Claude Code)');
    expect(screen.getByText(/anthropic is only the fallback provider family/i)).toBeTruthy();
  });

  it('shows rescan loading, avoids duplicate rescans, and renders the success notice', async () => {
    const nextAgents: AgentInfo[] = [
      availableAgents[0]!,
      {
        id: 'copilot',
        name: 'GitHub Copilot CLI',
        bin: 'copilot',
        available: true,
        version: '1.2.3',
        models: [{ id: 'default', label: 'Default' }],
      },
    ];
    const pending = deferred<AgentInfo[]>();
    const onRefreshAgents = vi.fn(() => pending.promise);

    renderSettingsDialog(
      { agentId: 'claude' },
      { agents: availableAgents, onRefreshAgents },
    );

    const rescanButton = screen.getByRole('button', { name: /Rescan|Scanning/i }) as HTMLButtonElement;

    fireEvent.click(rescanButton);
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);
    expect(onRefreshAgents).toHaveBeenCalledWith({
      throwOnError: true,
      agentCliEnv: {},
    });
    expect(rescanButton.disabled).toBe(true);
    expect(screen.getByText('Scanning...')).toBeTruthy();

    fireEvent.click(rescanButton);
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);

    pending.resolve(nextAgents);

    await waitFor(() => {
      expect(screen.getByText('Scan complete. 2 available.')).toBeTruthy();
      expect((screen.getByRole('button', { name: /Rescan/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('renders an error notice when rescan fails', async () => {
    const onRefreshAgents = vi.fn(async () => {
      throw new Error('boom');
    });

    renderSettingsDialog(
      { agentId: 'claude' },
      { agents: availableAgents, onRefreshAgents },
    );

    fireEvent.click(screen.getByRole('button', { name: /Rescan/i }));

    await waitFor(() => {
      expect(screen.getByText('Scan failed. Check the daemon and try again.')).toBeTruthy();
    });
  });

  it('rescans automatically when returning after opening an install link', async () => {
    const unavailable: AgentInfo = {
      id: 'copilot',
      name: 'GitHub Copilot CLI',
      bin: 'copilot',
      available: false,
      version: null,
      models: [],
      installUrl: 'https://github.com/github/copilot-cli',
    };
    const onRefreshAgents = vi.fn(async () => availableAgents);

    renderSettingsDialog(
      { agentId: 'claude' },
      { agents: [availableAgents[0]!, unavailable], onRefreshAgents },
    );

    fireEvent.click(screen.getByText('Available to install (1)'));
    fireEvent.click(screen.getByRole('link', { name: en['settings.agentInstall.install'] }));
    expect(onRefreshAgents).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(onRefreshAgents).toHaveBeenCalledWith({
        throwOnError: true,
        agentCliEnv: {},
      });
    });
  });

  it('autosaves CLI env overrides from the execution form', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'claude' },
      { agents: availableAgents },
    );

    expect(
      screen.getByLabelText('Claude proxy base URL'),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Claude Code config directory'), {
      target: { value: ' ~/.claude-team ' },
    });

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        agentId: 'claude',
        agentCliEnv: {
          claude: { CLAUDE_CONFIG_DIR: '~/.claude-team' },
        },
      }),
    );
  });
});

describe('SettingsDialog MCP server interactions', () => {
  const installInfo = {
    command: '/Applications/Open Design.app/Contents/Resources/open-design/bin/node',
    args: [
      '/Applications/Open Design.app/Contents/Resources/app/node_modules/@open-design/daemon/dist/cli.js',
      'mcp',
      '--daemon-url',
      'http://127.0.0.1:51706',
    ],
    daemonUrl: 'http://127.0.0.1:51706',
    platform: 'darwin',
    cliExists: true,
    nodeExists: true,
    buildHint: null,
  };

  let fetchMock: ReturnType<typeof vi.fn>;
  let writeTextMock: ReturnType<typeof vi.fn>;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => installInfo,
    });
    vi.stubGlobal('fetch', fetchMock);

    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
    vi.clearAllMocks();
  });

  it('renders the default Claude Code install snippet after fetching daemon install info', async () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/mcp/install-info');
    });
    expect(screen.getByText(/Run this in your terminal/i)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });
    expect(screen.getByText(/Restart your client to pick up the new server/i)).toBeTruthy();
    expect(screen.getByText(/Open Design must be running for MCP tool calls to succeed/i)).toBeTruthy();
  });

  it('switches client instructions and snippet content when a different MCP client is selected', async () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /Claude Code/i }));
    fireEvent.click(screen.getByRole('option', { name: /Codex/i }));

    await waitFor(() => {
      expect(screen.getByText(/Append this table to ~\/\.codex\/config\.toml/i)).toBeTruthy();
    });
    expect(screen.getByText(/\[mcp_servers\.open-design\]/i)).toBeTruthy();

    // Scope to the picker trigger ("Codex" + the TOML method chip) so
    // we don't collide with the new one-click "Install in Codex" /
    // "Remove from Codex" button on the same panel.
    fireEvent.click(screen.getByRole('button', { name: /Codex.*TOML/i }));
    fireEvent.click(screen.getByRole('option', { name: /Cursor/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Install in Cursor/i })).toBeTruthy();
    });
    expect(screen.getByText(/merge this JSON into ~\/\.cursor\/mcp\.json/i)).toBeTruthy();
    expect(screen.getByText(/"mcpServers"/i)).toBeTruthy();
  });

  it('copies the currently selected MCP snippet to the clipboard', async () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy MCP configuration snippet' }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining("claude mcp add-json --scope user open-design"),
      );
    });
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('shows a daemon error state when install paths cannot be resolved', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      const errorCard = document.querySelector('.empty-card');
      expect(errorCard?.textContent).toContain('reach the local daemon to resolve install paths');
    });
    expect(screen.getByText(/# resolving paths failed, see the error above/i)).toBeTruthy();
  });
});

describe('SettingsDialog language interactions', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem('open-design:locale');
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
  });

  it('shows every locale as a tile and marks the current locale as selected', async () => {
    renderLanguageSettingsDialog('en');

    const tiles = await screen.findAllByRole('radio');
    expect(tiles).toHaveLength(LOCALES.length);
    expect(screen.getByRole('radio', { name: /English/i }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /简体中文/i }).getAttribute('aria-checked')).toBe('false');
  });

  it('switches locale immediately and updates localStorage', async () => {
    renderLanguageSettingsDialog('en');

    fireEvent.click(screen.getByRole('radio', { name: /简体中文/i }));

    expect(screen.getByRole('radio', { name: /简体中文/i }).getAttribute('aria-checked')).toBe('true');
    expect(window.localStorage.getItem('open-design:locale')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('sets rtl direction for rtl locales', async () => {
    renderLanguageSettingsDialog('en');

    fireEvent.click(screen.getByRole('radio', { name: /فارسی/i }));

    expect(window.localStorage.getItem('open-design:locale')).toBe('fa');
    expect(document.documentElement.getAttribute('lang')).toBe('fa');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });

  it('does not route language changes through autosave and closing does not revert an applied locale', async () => {
    const { onPersist, onClose } = renderLanguageSettingsDialog('en');

    fireEvent.click(screen.getByRole('radio', { name: /Deutsch/i }));

    expect(window.localStorage.getItem('open-design:locale')).toBe('de');
    expect(document.documentElement.getAttribute('lang')).toBe('de');

    fireEvent.click(screen.getByTitle(/close|schließen/i));
    expect(onPersist).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('open-design:locale')).toBe('de');
    expect(document.documentElement.getAttribute('lang')).toBe('de');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });
});

describe('SettingsDialog notifications interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders notifications offline by default and only reveals sound pickers when enabled', () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'notifications' },
    );

    expect(screen.getByRole('group', { name: 'Completion sound' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'offline' })[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Success sound' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Failure sound' })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'offline' })[0] as HTMLButtonElement);
    expect(playSoundMock).toHaveBeenCalledWith('ding');
    expect(screen.getByRole('group', { name: 'Success sound' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Failure sound' })).toBeTruthy();
  });

  it('updates completion success and failure sounds and autosaves the edited notification config', async () => {
    const { onPersist } = renderSettingsDialog(
      {
        agentId: 'claude',
        notifications: {
          soundEnabled: true,
          successSoundId: 'chime',
          failureSoundId: 'two-tone-down',
          desktopEnabled: false,
        },
      },
      { initialSection: 'notifications' },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pluck' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thud' }));

    expect(playSoundMock).toHaveBeenNthCalledWith(1, 'pluck');
    expect(playSoundMock).toHaveBeenNthCalledWith(2, 'thud');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        notifications: {
          soundEnabled: true,
          successSoundId: 'pluck',
          failureSoundId: 'thud',
          desktopEnabled: false,
        },
      }),
    );
  });

  it('enables desktop notifications after permission is granted and sends a test notification', async () => {
    notificationPermissionMock.mockReturnValueOnce('default').mockReturnValue('granted');
    requestNotificationPermissionMock.mockResolvedValue('granted');
    showCompletionNotificationMock.mockResolvedValue('shown');

    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'notifications' },
    );

    const desktopToggle = screen.getAllByRole('button', { name: 'offline' })[1] as HTMLButtonElement;
    fireEvent.click(desktopToggle);

    await waitFor(() => {
      expect(requestNotificationPermissionMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'active' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    await waitFor(() => {
      expect(showCompletionNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded' }),
      );
    });
    expect(screen.getByText(/Test notification sent/i)).toBeTruthy();
  });

  it('shows a blocked hint and keeps desktop notifications disabled when permission is denied', async () => {
    notificationPermissionMock.mockReturnValueOnce('default').mockReturnValue('denied');
    requestNotificationPermissionMock.mockResolvedValue('denied');

    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'notifications' },
    );

    const desktopToggle = screen.getAllByRole('button', { name: 'offline' })[1] as HTMLButtonElement;
    fireEvent.click(desktopToggle);

    await waitFor(() => {
      expect(requestNotificationPermissionMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/Notifications blocked by the browser/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
  });

  it('closes notification settings via the close button or backdrop', () => {
    const first = renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'notifications' },
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'offline' })[0] as HTMLButtonElement);
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'notifications' },
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'offline' })[0] as HTMLButtonElement);
    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsDialog appearance interactions', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-strong');
    document.documentElement.style.removeProperty('--accent-soft');
    document.documentElement.style.removeProperty('--accent-tint');
    document.documentElement.style.removeProperty('--accent-hover');
  });

  it('treats System as the selected appearance mode when theme is unset or system', () => {
    renderSettingsDialog(
      { theme: 'system' },
      { initialSection: 'appearance' },
    );

    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('applies the first accent color as the default appearance color', () => {
    renderSettingsDialog(
      { theme: 'system' },
      { initialSection: 'appearance' },
    );

    expect(screen.getByRole('radio', { name: 'Default accent color' }).getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#c96442');
  });

  it('live previews explicit themes and removes the explicit document theme when switching back to System', () => {
    renderSettingsDialog(
      { theme: 'dark' },
      { initialSection: 'appearance' },
    );

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reverts an unsaved appearance preview back to the saved theme when the dialog closes', () => {
    const first = renderSettingsDialog(
      { theme: 'dark' },
      { initialSection: 'appearance' },
    );

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('persists System mode explicitly and preserves accent variables without an explicit document theme', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'claude', theme: 'dark', accentColor: '#2563eb' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        theme: 'system',
        accentColor: '#2563eb',
      }),
    );
  });

  it('switches back to the default accent color and persists it explicitly', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'claude', theme: 'light', accentColor: '#2563eb' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Default accent color' }));

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#c96442');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        accentColor: '#c96442',
      }),
    );
  });

  it('keeps an autosaved accent color applied after the dialog closes', async () => {
    const view = renderSettingsDialog(
      { agentId: 'claude', theme: 'light', accentColor: '#2563eb' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('radio', { name: '#059669' }));

    await waitForPersist(
      view.onPersist,
      expect.objectContaining({
        accentColor: '#059669',
      }),
    );

    fireEvent.click(view.container.querySelector('.settings-close') as HTMLElement);
    expect(view.onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#059669');
  });

  it('live previews and autosaves preset and custom accent colors', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'claude', theme: 'light' },
      { initialSection: 'appearance' },
    );

    fireEvent.click(screen.getByRole('radio', { name: '#059669' }));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#059669');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        accentColor: '#059669',
      }),
    );

    fireEvent.change(screen.getByLabelText('Custom color'), {
      target: { value: '#123456' },
    });
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        accentColor: '#123456',
      }),
    );
  });

  it('localizes the accent color controls in Chinese', () => {
    render(
      <I18nProvider initial="zh-CN">
        <SettingsDialog
          initial={{ ...baseConfig, theme: 'light' }}
          agents={availableAgents}
          daemonLive={true}
          appVersionInfo={null}
          initialSection="appearance"
          onPersist={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('主题色')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '主题色' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '默认主题色' })).toBeTruthy();
    expect(screen.getByLabelText('自定义颜色')).toBeTruthy();
  });
});

describe('SettingsDialog pets interactions', () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');

  afterEach(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(window.navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(window.navigator, 'clipboard');
    }
    cleanup();
  });

  it('renders bundled pets by default and exposes community pets in a separate tab', async () => {
    fetchCodexPetsMock.mockResolvedValue({
      pets: [...sampleBundledPets, ...sampleCommunityPets],
      rootDir: '/Users/test/.codex/pets',
    });

    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'pet' },
    );

    expect((screen.getByRole('button', { name: 'Show pet' }) as HTMLButtonElement).disabled).toBe(false);

    await waitFor(() => {
      expect(screen.getByText('Dario')).toBeTruthy();
      expect(screen.getByText('Nyako')).toBeTruthy();
    });
    expect(screen.queryByText('Jade')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Community' }));
    expect(screen.getByText('Recently hatched')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download community pets' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByText('Jade')).toBeTruthy();
    expect(screen.getByText('Voidling')).toBeTruthy();
  });

  it('supports editing and persisting a custom pet', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'pet' },
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));

    fireEvent.change(screen.getByDisplayValue('Buddy'), {
      target: { value: 'Scout' },
    });
    fireEvent.change(screen.getByDisplayValue('🦄'), {
      target: { value: '🤖' },
    });
    fireEvent.change(screen.getByDisplayValue('Hi! I am here whenever you need me.'), {
      target: { value: 'Hi there, builder.' },
    });
    fireEvent.click(document.querySelector('.pet-swatch[title="#2348b8"]') as HTMLElement);

    expect(screen.getAllByText('Scout').length).toBeGreaterThan(0);
    expect(screen.getByText('Hi there, builder.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use my pet' }));

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        pet: expect.objectContaining({
          adopted: true,
          enabled: true,
          petId: 'custom',
          custom: expect.objectContaining({
            name: 'Scout',
            glyph: '🤖',
            greeting: 'Hi there, builder.',
            accent: '#2348b8',
          }),
        }),
      }),
    );
  });

  it('toggles an adopted pet between tucked and awake states', async () => {
    const { onPersist } = renderSettingsDialog(
      {
        agentId: 'claude',
        pet: {
          adopted: true,
          enabled: true,
          petId: 'custom',
          custom: {
            name: 'Buddy',
            glyph: '🦄',
            accent: '#c96442',
            greeting: 'Hi! I am here whenever you need me.',
          },
        },
      },
      { initialSection: 'pet' },
    );

    const toggle = screen.getByRole('button', { name: 'Hide pet' });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show pet' })).toBeTruthy();
    expect(screen.getByText('Hide pet')).toBeTruthy();

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        pet: expect.objectContaining({
          adopted: true,
          enabled: false,
        }),
      }),
    );
  });

  it('refreshes and syncs community pets with inline status feedback', async () => {
    fetchCodexPetsMock.mockResolvedValue({
      pets: sampleCommunityPets,
      rootDir: '/Users/test/.codex/pets',
    });
    syncCommunityPetsMock.mockResolvedValue({
      wrote: 2,
      skipped: 1,
      failed: 0,
      total: 5,
      rootDir: '/Users/test/.codex/pets',
      errors: [],
    });

    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'pet' },
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Community' }));
    await waitFor(() => {
      expect(fetchCodexPetsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(fetchCodexPetsMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download community pets' }));
    await waitFor(() => {
      expect(syncCommunityPetsMock).toHaveBeenCalledTimes(1);
      expect(fetchCodexPetsMock).toHaveBeenCalledTimes(3);
      expect(screen.getByText('Synced 2 new pets (5 total).')).toBeTruthy();
    });
  });

  it('copies the hatch prompt with the current concept', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'pet' },
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Community' }));
    fireEvent.change(screen.getByLabelText('Pet concept (optional)'), {
      target: { value: 'a tiny pixel-art bee in a cozy sweater' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('Concept: a tiny pixel-art bee in a cozy sweater.'),
      );
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('Use the @hatch-pet skill end-to-end:'),
      );
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
    });
  });
});

describe('IntegrationsView skills tab', () => {
  afterEach(() => {
    cleanup();
  });

  it('lists functional skills and filters them by mode + search', async () => {
    renderIntegrationsView(
      { agentId: 'claude' },
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
      expect(screen.getByText('sales-deck')).toBeTruthy();
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), {
      target: { value: 'deck' },
    });
    expect(screen.queryByText('blog-post')).toBeNull();
    expect(screen.getByText('sales-deck')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'sales' },
    });
    expect(screen.getByText('sales-deck')).toBeTruthy();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('opens a skill detail panel and persists disabled skills from toggle switches', async () => {
    const { onConfigPersist } = renderIntegrationsView(
      { agentId: 'claude' },
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('blog-post'));
    await waitFor(() => {
      expect(fetchSkillMock).toHaveBeenCalledWith('blog-post');
      expect(screen.getByText('skill body for blog-post')).toBeTruthy();
    });

    const toggles = screen.getAllByTitle('Toggle');
    fireEvent.click(toggles[0] as HTMLElement);

    await waitFor(() => {
      expect(onConfigPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          disabledSkills: ['blog-post'],
        }),
      );
    });
  });

  it('shows an empty state when search matches nothing', async () => {
    renderIntegrationsView(
      { agentId: 'claude' },
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText('No items match your search.')).toBeTruthy();
  });
});

describe('SettingsDialog design systems section', () => {
  afterEach(() => {
    cleanup();
  });

  it('lists design systems and persists disabled selections from toggle switches', async () => {
    const { onPersist } = renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'designSystems' },
    );

    await waitFor(() => {
      expect(screen.getByText('Neutral Modern')).toBeTruthy();
      expect(screen.getByText('Signal Green')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'Experimental' },
    });
    expect(screen.queryByText('Neutral Modern')).toBeNull();
    expect(screen.getByText('Signal Green')).toBeTruthy();

    fireEvent.click(screen.getByText('Signal Green'));
    await waitFor(() => {
      expect(fetchDesignSystemMock).toHaveBeenCalledWith('signal-green');
      expect(screen.getByText('design system body for signal-green')).toBeTruthy();
    });

    fireEvent.click(screen.getAllByLabelText('Show in home gallery')[0] as HTMLElement);

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        disabledDesignSystems: ['signal-green'],
      }),
    );
  });

  it('shows an imported design system from the hidden-only import CTA', async () => {
    renderSettingsDialog(
      {
        agentId: 'claude',
        disabledDesignSystems: ['neutral-modern'],
      },
      { initialSection: 'designSystems' },
    );

    await waitFor(() => {
      expect(screen.getByText('Neutral Modern')).toBeTruthy();
      expect(screen.getByText('Signal Green')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }));
    expect(screen.getByText('Neutral Modern')).toBeTruthy();
    expect(screen.queryByText('Signal Green')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add design system' }));
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/imported-system' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import from project' }));

    await waitFor(() => {
      expect(importLocalDesignSystemMock).toHaveBeenCalledWith({
        baseDir: '/tmp/imported-system',
        importMode: 'hybrid',
        craftApplies: [],
      });
      expect(screen.getByText('Imported Imported System')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'View imported design system' }));

    await waitFor(() => {
      expect(screen.getByText('Imported System')).toBeTruthy();
    });
    expect(screen.queryByText('No items match your search.')).toBeNull();
  });
});

describe('SettingsDialog about interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders app version and runtime details when version info is available', () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(screen.getByText('Version')).toBeTruthy();
    expect(screen.getByText('0.4.1')).toBeTruthy();
    expect(screen.getByText('Channel')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.getByText('Runtime')).toBeTruthy();
    expect(screen.getByText('Packaged app')).toBeTruthy();
    expect(screen.getByText('Platform')).toBeTruthy();
    expect(screen.getByText('darwin')).toBeTruthy();
    expect(screen.getByText('Architecture')).toBeTruthy();
    expect(screen.getByText('arm64')).toBeTruthy();
  });

  it('renders the unavailable fallback when app version info is missing', () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      { initialSection: 'about', appVersionInfo: null },
    );

    expect(
      screen.getByText(/Version details are unavailable while the daemon is offline\./i),
    ).toBeTruthy();
  });

  it('does not create dirty state on the about page', () => {
    const first = renderSettingsDialog(
      { agentId: 'claude' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: false,
          platform: 'linux',
          arch: 'x64',
        },
      },
    );

    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      { agentId: 'claude' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: false,
          platform: 'linux',
          arch: 'x64',
        },
      },
    );

    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows development builds as unsupported for in-app updates', () => {
    renderSettingsDialog(
      { agentId: 'claude' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: false,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(screen.getByText(en['settings.updateStatusDevelopment'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: en['settings.installLatest'] })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en['settings.updateViewReleases'] }));

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/nexu-io/open-design/releases');
  });

  it('downloads an available packaged update from the about page', async () => {
    const available = updateStatus({
      availableVersion: '1.2.3-beta.4',
      state: 'available',
    });
    const downloaded = updateStatus({
      artifact: {
        name: 'Open Design Beta.dmg',
        platformKey: 'macAppleSilicon',
        type: 'dmg',
        url: 'https://fixture.test/Open Design Beta.dmg',
      },
      availableVersion: '1.2.3-beta.4',
      downloadPath: '/tmp/open-design-updater/Open Design Beta.dmg',
      state: 'downloaded',
    });
    const download = vi.fn(async () => downloaded);
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          download,
          status: vi.fn(async () => available),
        },
      },
    });

    renderSettingsDialog(
      { agentId: 'claude' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(
      await screen.findByText('New version 1.2.3-beta.4 found. Preparing download.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en['updater.download'] }));

    await waitFor(() => {
      expect(download).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
    expect(screen.getByText('Version 1.2.3-beta.4 is ready to install.')).toBeTruthy();
  });

  it('installs a downloaded payload update from the about page', async () => {
    const payloadReady = updateStatus({
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
    });
    const installing = updateStatus({
      ...payloadReady,
      state: 'installing',
    });
    const install = vi.fn(async () => installing);
    const quit = vi.fn(async () => ({ ok: true as const }));
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          install,
          quit,
          status: vi.fn(async () => payloadReady),
        },
      },
    });

    renderSettingsDialog(
      { agentId: 'claude' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(await screen.findByText('Version 1.2.3-beta.4 is ready to install.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en['updater.installRestart'] }));

    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
    await waitFor(() => {
      expect(quit).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
  });

  it('keeps a quit retry action when update install succeeds but quit fails', async () => {
    const payloadReady = updateStatus({
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
    });
    const installed = updateStatus({
      ...payloadReady,
      installResult: {
        dryRun: true,
        openedAt: '2026-05-19T00:00:00.000Z',
        path: '/tmp/open-design-updater/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
      },
    });
    const install = vi.fn(async () => installed);
    const quit = vi.fn(async () => ({
      ok: false as const,
      reason: 'desktop quit is not available',
    }));
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          install,
          quit,
          status: vi.fn(async () => payloadReady),
        },
      },
    });

    renderSettingsDialog(
      { agentId: 'claude' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    fireEvent.click(await screen.findByRole('button', { name: en['updater.installRestart'] }));

    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
    await waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: en['updater.quitButton'] })).toBeTruthy();
    expect(screen.getAllByText(en['settings.updateQuitFailed']).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: en['updater.quitButton'] }));

    await waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(2);
    });
    expect(install).toHaveBeenCalledTimes(1);
  });
});
