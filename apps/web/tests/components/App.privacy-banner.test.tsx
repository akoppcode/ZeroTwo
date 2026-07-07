// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AppConfig } from '../../src/types';
import {
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { listProjects, listTemplates } from '../../src/state/projects';

const useRouteMock = vi.fn(() => ({ kind: 'home' as const, view: 'home' as const }));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => useRouteMock(),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({
    onOpenSettings,
  }: {
    onOpenSettings: (section?: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenSettings()}>
        Open execution settings
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <div>Project view</div>,
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: ({
    initialSection,
  }: {
    initialSection?: string;
  }) => (
    <div role="dialog" aria-label="Settings dialog">
      <div>Section: {initialSection}</div>
    </div>
  ),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    fetchDaemonConfig: vi.fn().mockResolvedValue({}),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);
const mockedFetchPromptTemplates = vi.mocked(fetchPromptTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedMergeDaemonConfig = vi.mocked(mergeDaemonConfig);

const baseConfig: AppConfig = {
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

describe('App privacy banner flows', () => {
  beforeEach(() => {
    mockedDaemonIsLive.mockResolvedValue(true);
    mockedFetchAgentsStream.mockResolvedValue([]);
    mockedFetchSkills.mockResolvedValue([]);
    mockedFetchDesignSystems.mockResolvedValue([]);
    mockedFetchPromptTemplates.mockResolvedValue([]);
    mockedFetchAppVersionInfo.mockResolvedValue(null);
    mockedListProjects.mockResolvedValue([]);
    mockedListTemplates.mockResolvedValue([]);
    mockedFetchDaemonConfig.mockResolvedValue({});
    mockedMergeDaemonConfig.mockImplementation((local) => local);
    mockedLoadConfig.mockReturnValue({ ...baseConfig });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not show first-run privacy consent until daemon config hydration finishes', async () => {
    let resolveDaemonConfig: (value: Record<string, never>) => void = () => {};
    mockedFetchDaemonConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveDaemonConfig = resolve;
      }),
    );

    const { container } = render(<App />);

    await waitFor(() => {
      expect(mockedFetchDaemonConfig).toHaveBeenCalled();
    });
    expect(container.querySelector('.privacy-consent-banner')).toBeNull();

    resolveDaemonConfig({});

    await waitFor(() => {
      expect(container.querySelector('.privacy-consent-banner')).toBeTruthy();
    });
    const banner = container.querySelector('.privacy-consent-banner');
    expect(banner?.querySelector('.seg-control')).toBeNull();
    expect(banner?.querySelector('.seg-btn.active')).toBeNull();
    expect(screen.getByRole('button', { name: 'I get it' }).className).toContain(
      'privacy-consent-action',
    );
  });

  it('keeps the first-run privacy banner mounted while settings is open', async () => {
    // The banner and Settings have independent lifecycles. The banner's
    // z-index in index.css sits above the modal backdrop, so opening
    // Settings (or any other modal) must not unmount the banner — the
    // user has to be able to acknowledge the disclosure from any view.
    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.privacy-consent-banner')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open execution settings' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Settings dialog' })).toBeTruthy();
    });
    expect(container.querySelector('.privacy-consent-banner')).toBeTruthy();
  });

  it('withholds the privacy banner until onboarding completes', async () => {
    // First-run users should land on the welcome panel without the
    // privacy disclosure layered on top. The banner appears only after
    // onboardingCompleted flips to true (Skip and finish both flip it).
    mockedLoadConfig.mockReturnValue({ ...baseConfig, onboardingCompleted: false });
    mockedFetchDaemonConfig.mockResolvedValue({ onboardingCompleted: false });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(mockedFetchDaemonConfig).toHaveBeenCalled();
    });
    // Give the bootstrap microtasks a turn to settle; banner must still
    // be absent because onboardingCompleted is false.
    await waitFor(() => {
      expect(container.querySelector('.privacy-consent-banner')).toBeNull();
    });
  });

  it('shows the privacy banner on non-home routes once onboarding completes', async () => {
    // The design-system finish path drops the user into a project view
    // (the first generation runs there). Product wants the disclosure to
    // appear in that view too — the user is already waiting for output,
    // so there is no benefit to delaying the banner until they navigate
    // back to home.
    useRouteMock.mockReturnValue({
      kind: 'project',
      projectId: 'proj-1',
      conversationId: null,
      fileName: null,
    } as never);

    try {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.privacy-consent-banner')).toBeTruthy();
      });
    } finally {
      useRouteMock.mockReturnValue({
        kind: 'home' as const,
        view: 'home' as const,
      } as never);
    }
  });
});
