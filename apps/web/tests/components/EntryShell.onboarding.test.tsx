// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      track: analyticsMocks.track,
    }),
    useAppVersion: () => null,
  };
});

const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cliAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agentId: null,
    skillId: null,
    designSystemId: null,
    agentModels: {},
    ...overrides,
  };
}

function renderOnboarding(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
) {
  window.history.replaceState(null, '', '/onboarding');
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig({ agentId: 'claude' }),
    agents: [cliAgent()],
    daemonLive: true,
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onThemeChange: vi.fn(),
    onCreateProject: vi.fn(),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

function renderHome(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
  path = '/',
) {
  window.history.replaceState(null, '', path);
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig({
      agentId: 'claude',
      agentModels: { claude: { model: 'sonnet' } },
      theme: 'system',
    }),
    agents: [cliAgent()],
    daemonLive: true,
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onThemeChange: vi.fn(),
    onCreateProject: vi.fn(),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

function trackedEvents(name: string) {
  return analyticsMocks.track.mock.calls.filter(([eventName]) => eventName === name);
}

function latestTrackedEvent<T extends Record<string, unknown>>(name: string): T {
  const calls = trackedEvents(name);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]?.[1] as T;
}

function findTrackedEvent<T extends Record<string, unknown>>(
  name: string,
  predicate: (payload: T) => boolean,
): T {
  const payload = trackedEvents(name)
    .map(([, eventPayload]) => eventPayload as T)
    .find(predicate);
  expect(payload).toBeTruthy();
  return payload as T;
}

function chooseOnboardingOption(label: string, option: string | RegExp) {
  const chipField = screen
    .getAllByText(label)
    .map((node) => node.closest('.onboarding-chip-field'))
    .find((node): node is HTMLElement => node instanceof HTMLElement);
  if (!chipField) throw new Error(`profile field not found: ${label}`);
  const matcher = option instanceof RegExp ? option : new RegExp(option, 'i');
  const chip = Array.from(chipField.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    matcher.test(button.textContent ?? ''),
  );
  if (!(chip instanceof HTMLButtonElement)) {
    throw new Error(`profile chip not found: ${label} / ${String(option)}`);
  }
  fireEvent.click(chip);
}

async function continueToAboutYou() {
  fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'About you' })).toBeTruthy();
  });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  vi.useRealTimers();
  analyticsMocks.track.mockReset();
  window.sessionStorage.clear();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  analyticsMocks.track.mockReset();
});

describe('EntryShell settings menu', () => {
  // Zero Two: skipped — asserts the open-design topbar Discord badge ("1.2k
  // online") + community promo links that were stripped from the Zero Two shell.
  it.skip('opens quick actions before opening the full settings dialog', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/community/discord')) {
        return jsonResponse({
          inviteCode: 'mHAjSMV6gz',
          inviteUrl: 'https://discord.gg/mHAjSMV6gz',
          onlineCount: 1234,
          memberCount: 4321,
          fetchedAt: Date.now(),
          stale: false,
        });
      }
      if (url.endsWith('/api/github/open-design')) {
        return jsonResponse({
          repo: 'nexu-io/open-design',
          stargazers_count: 56100,
          fetchedAt: Date.now(),
          stale: false,
        });
      }
      return jsonResponse({});
    }) as typeof fetch;
    const props = renderHome();

    await waitFor(() => {
      expect(screen.getByText('1.2k online')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    expect(props.onOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('entry-settings-menu')).toBeTruthy();
    expect(screen.getByText('Language')).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Join Discord/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /1.2k online/i })).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: /Follow @OpenDesignHQ on X/i }).getAttribute('href'),
    ).toBe('https://x.com/OpenDesignHQ');
    expect(
      screen.getByRole('menuitem', { name: /Follow Open Design on Threads/i }).getAttribute('href'),
    ).toBe('https://www.threads.com/@opendesign.ai');
    expect(
      screen.getByRole('menuitem', { name: /Open Design on YouTube/i }).getAttribute('href'),
    ).toBe('https://www.youtube.com/@Open-Design-ai');

    fireEvent.click(screen.getByTestId('entry-settings-open-details'));

    expect(props.onOpenSettings).toHaveBeenCalledWith();
  });
});

describe('EntryShell design systems view', () => {
  it('refreshes the design-system catalog when the view is active', async () => {
    const onDesignSystemsRefresh = vi.fn();
    renderHome({ onDesignSystemsRefresh }, '/design-systems');

    await waitFor(() => expect(onDesignSystemsRefresh).toHaveBeenCalledTimes(1));
  });
});

describe('EntryShell new project rail', () => {
  // Zero Two: the rail "+" opens the Zero Two New report wizard on the Reports
  // home, not the open-design new-project modal.
  it('opens the Zero Two New report wizard from the rail plus', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'false');
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.endsWith('/api/projects') && init?.method === 'POST') {
          return jsonResponse({
            project: {
              id: 'blank-project-1',
              name: 'Untitled',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            conversationId: 'conversation-1',
          });
        }
        if (url.endsWith('/api/community/discord')) {
          return jsonResponse({
            inviteCode: 'mHAjSMV6gz',
            inviteUrl: 'https://discord.gg/mHAjSMV6gz',
            onlineCount: 0,
            memberCount: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        if (url.endsWith('/api/github/open-design')) {
          return jsonResponse({
            repo: 'nexu-io/open-design',
            stargazers_count: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        return jsonResponse({});
      });
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderHome();

    fireEvent.click(screen.getByTestId('entry-rail-toggle'));
    fireEvent.click(screen.getByTestId('entry-nav-new-project'));

    await waitFor(() => {
      expect(screen.getByTestId('new-step-basics')).toBeTruthy();
    });
    expect(screen.getByTestId('new-name-input')).toBeTruthy();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onCreateProject).not.toHaveBeenCalled();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/projects' && init?.method === 'POST',
    );
    expect(createCall).toBeUndefined();
    expect(analyticsMocks.track).toHaveBeenCalledWith(
      'ui_click',
      expect.objectContaining({
        page_name: 'home',
        area: 'nav',
        element: 'new_project_plus',
      }),
      undefined,
    );
  });

  // Zero Two: nav reduced to Reports+Doctor — the open-design Projects nav
  // button was removed, so this open-design surface is no longer reachable.
  it.skip('opens the new project modal from the Projects tab button', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'false');
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url === '/api/projects' && init?.method === 'POST') {
          return jsonResponse({
            project: {
              id: 'blank-project-from-projects',
              name: 'Untitled',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            conversationId: 'conversation-2',
          });
        }
        if (url.endsWith('/api/projects/project-existing/files')) {
          return jsonResponse({ files: [] });
        }
        if (url.endsWith('/api/live-artifacts?projectId=project-existing')) {
          return jsonResponse({ liveArtifacts: [] });
        }
        if (url.endsWith('/api/community/discord')) {
          return jsonResponse({
            inviteCode: 'mHAjSMV6gz',
            inviteUrl: 'https://discord.gg/mHAjSMV6gz',
            onlineCount: 0,
            memberCount: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        if (url.endsWith('/api/github/open-design')) {
          return jsonResponse({
            repo: 'nexu-io/open-design',
            stargazers_count: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        return jsonResponse({});
      });
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderHome({
      projects: [
        {
          id: 'project-existing',
          name: 'Existing project',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 2,
          status: { value: 'not_started' },
        },
      ],
    });

    fireEvent.click(screen.getByTestId('entry-rail-toggle'));
    fireEvent.click(screen.getByTestId('entry-nav-projects'));
    fireEvent.click(screen.getByTestId('designs-new-project'));

    await waitFor(() => {
      expect(screen.getByTestId('new-project-modal')).toBeTruthy();
    });
    expect(screen.getByTestId('new-project-panel')).toBeTruthy();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onCreateProject).not.toHaveBeenCalled();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/projects' && init?.method === 'POST',
    );
    expect(createCall).toBeUndefined();
    expect(analyticsMocks.track).toHaveBeenCalledWith(
      'ui_click',
      expect.objectContaining({
        page_name: 'projects',
        area: 'list_controls',
        element: 'create_project',
      }),
      undefined,
    );
  });
});

describe('EntryShell Home submit handoff', () => {
  // Zero Two: nav reduced to Reports+Doctor and the default view is now the
  // Zero Two Reports home, so the open-design Home hero is no longer the
  // launch surface. This exercises that removed open-design default.
  it.skip('keeps the Home run button in sending state until project creation resolves', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/plugins')) return jsonResponse({ plugins: [] });
      if (url.endsWith('/api/mcp/servers')) return jsonResponse({ servers: [] });
      if (url.endsWith('/api/community/discord')) return jsonResponse({ stale: true });
      if (url.endsWith('/api/github/open-design')) return jsonResponse({ stale: true });
      return jsonResponse({});
    }) as typeof fetch;
    let resolveCreate: (accepted: boolean) => void = () => undefined;
    const onCreateProject = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveCreate = resolve; }),
    );
    renderHome({ onCreateProject });

    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('Build a landing page');
    const submit = await screen.findByTestId('home-hero-submit') as HTMLButtonElement;
    fireEvent.click(submit);

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain('Sending…');

    resolveCreate(true);
    await waitFor(() => expect(submit.disabled).toBe(false));
  });
});

describe('EntryShell onboarding local CLI connect step', () => {
  it('shows the Local CLI setup panel with detected agents and no cloud/BYOK surfaces', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    renderOnboarding();

    expect(
      await screen.findByRole('heading', { name: 'Local coding agent' }),
    ).toBeTruthy();
    await waitFor(() => {
      const localPanel = screen
        .getByText('Local CLI')
        .closest('.onboarding-view__setup-panel');
      expect(localPanel?.textContent).toContain('Claude Code');
    });
    expect(screen.queryByRole('button', { name: /Sign in to Open Design/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Bring your own key/i })).toBeNull();
    expect(screen.queryByText('AMR')).toBeNull();
  });

  it('keeps Continue gated while no available CLI agent is selected', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig(),
      agents: [],
      onRefreshAgents: vi.fn(() => []),
    });

    const continueButton = await screen.findByRole('button', { name: /^Continue$/i });
    expect(continueButton.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(continueButton);
    await act(async () => {});

    // Still on the Connect step; onboarding is not completed from here.
    expect(screen.getByRole('heading', { name: 'Local coding agent' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'About you' })).toBeNull();
    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();
  });

  it('shows no Skip affordance on the Connect step', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    const props = renderOnboarding();
    await act(async () => {});

    // "Skip for now" was removed — Connect is a required step. The Connect
    // step exposes no secondary Skip/Back button, onboarding is not completed
    // from here, and no skip telemetry fires.
    expect(screen.queryByRole('button', { name: /Skip/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Back$/i })).toBeNull();
    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();
    const skipClicks = trackedEvents('ui_click')
      .map(([, payload]) => payload as Record<string, unknown>)
      .filter((payload) => payload.element === 'skip');
    expect(skipClicks).toHaveLength(0);
    expect(trackedEvents('onboarding_complete_result')).toHaveLength(0);
  });

  it('shows a Back control on the brand extraction onboarding step', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    renderOnboarding();

    await continueToAboutYou();
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Stay in the loop' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create once, build everywhere' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /^Back$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Build a design system' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Skip for now/i })).toBeNull();
  });

  it('tracks onboarding page views and about-you submission payload on completion', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    const props = renderOnboarding();

    await continueToAboutYou();

    chooseOnboardingOption('Your role', 'Engineer');
    chooseOnboardingOption('Organization size', /Growth company/i);
    chooseOnboardingOption('Use case', /Product design/i);
    chooseOnboardingOption('Where did you hear about us?', /Search/i);
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Stay in the loop' })).toBeTruthy();
    });
    await waitFor(() => {
      expect(document.querySelector('.onboarding-view__email-input')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create once, build everywhere' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build a design system' }));

    await waitFor(() => {
      expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    });

    const pageViews = trackedEvents('page_view').map(([, payload]) => payload);
    expect(pageViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page_name: 'onboarding',
          area: 'runtime',
          step_index: '1',
          step_name: 'connect',
        }),
        expect.objectContaining({
          page_name: 'onboarding',
          area: 'about_you',
          step_index: '2',
          step_name: 'about_you',
        }),
        expect.objectContaining({
          page_name: 'onboarding',
          area: 'newsletter',
          step_index: '3',
          step_name: 'newsletter',
        }),
        expect.objectContaining({
          page_name: 'onboarding',
          area: 'design_system',
          step_index: '4',
          step_name: 'design_system',
        }),
      ]),
    );

    // The About-you survey snapshot fires when the user continues past
    // the About-you step and carries the role/org/use-case/source picks.
    expect(findTrackedEvent('ui_click', (payload) => payload.element === 'about_you_submit')).toMatchObject({
      page_name: 'onboarding',
      area: 'about_you',
      element: 'about_you_submit',
      action: 'continue',
      role: 'engineer',
      organization_size: 'growth',
      use_cases: ['product'],
      discovery_source: 'search',
    });

    expect(latestTrackedEvent('onboarding_complete_result')).toMatchObject({
      page_name: 'onboarding',
      area: 'onboarding',
      result: 'completed',
      exit_step_name: 'design_system',
      // This flow clicks "Build a design system" at the final step, so the
      // completion records the with-DS fork (C2 — tracking spec §3.1).
      completion_type: 'completed_with_design_system',
      runtime_type: 'local_cli',
      has_about_you: true,
      has_design_system_request: false,
      role: 'engineer',
      organization_size: 'growth',
      use_cases: ['product'],
      discovery_source: 'search',
    });
  });

  it('submits the optional newsletter email when finishing onboarding', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/subscribe')) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    globalThis.fetch = fetchMock as typeof fetch;
    renderOnboarding();

    // Connect -> About you -> Newsletter -> Brand
    await continueToAboutYou();
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Stay in the loop' })).toBeTruthy();
    });
    await waitFor(() => {
      expect(document.querySelector('.onboarding-view__email-input')).toBeTruthy();
    });

    const emailInput = document.querySelector('.onboarding-view__email-input');
    expect(emailInput).toBeInstanceOf(HTMLInputElement);
    expect((emailInput as HTMLInputElement).placeholder).toBe('you@studio.com');

    fireEvent.change(emailInput as HTMLInputElement, {
      target: { value: '  Tester@Studio.com  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create once, build everywhere' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build a design system' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/subscribe'))).toBe(true);
    });
    const subscribeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/subscribe'));
    expect(JSON.parse(String(subscribeCall?.[1]?.body))).toEqual({
      email: 'tester@studio.com',
      source: 'client',
    });

    expect(findTrackedEvent('ui_click', (payload) => payload.element === 'newsletter_email')).toMatchObject({
      page_name: 'onboarding',
      element: 'newsletter_email',
      action: 'subscribe',
      newsletter_opt_in: true,
    });
  });

  it('skips the newsletter request when the email field is left blank', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({}));
    globalThis.fetch = fetchMock as typeof fetch;
    renderOnboarding();

    await continueToAboutYou();
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(document.querySelector('.onboarding-view__email-input')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create once, build everywhere' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build a design system' }));

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/subscribe'))).toBe(false);
  });

  it('persists about-you selections to the work profile memory', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/memory/user_profile' && init?.method === 'PUT') {
        return jsonResponse({
          entry: {
            id: 'user_profile',
            name: 'Work profile',
            description: 'Role and defaults',
            type: 'profile',
            updatedAt: Date.now(),
            body: JSON.parse(String(init.body)).body,
          },
        });
      }
      return jsonResponse({});
    });
    globalThis.fetch = fetchMock as typeof fetch;
    renderOnboarding();

    await continueToAboutYou();
    chooseOnboardingOption('Your role', 'Engineer');
    chooseOnboardingOption('Organization size', 'Growth company');
    chooseOnboardingOption('Use case', 'Product design');
    chooseOnboardingOption('Where did you hear about us?', 'Search');

    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/memory/user_profile')).toBe(true);
    });
    const memoryCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/memory/user_profile');
    const payload = JSON.parse(String(memoryCall?.[1]?.body));
    expect(memoryCall?.[1]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(payload).toMatchObject({
      type: 'profile',
      name: 'Work profile',
    });
    expect(payload.body).toContain('- Role: Engineer');
    expect(payload.body).toContain('- Organization size: Growth company');
    expect(payload.body).toContain('- Use cases: Product design');
    expect(payload.body).toContain('- Discovery source: Search');
  });

  it('reports about_you_submit exactly once when advancing to the newsletter step', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    renderOnboarding();

    await continueToAboutYou();
    chooseOnboardingOption('Your role', 'Engineer');

    // Advance to the newsletter step via Continue (the stepper no longer
    // allows forward jumps past the current step). The survey snapshot must
    // still fire exactly once — on the final Finish — not zero times.
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Stay in the loop' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create once, build everywhere' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build a design system' }));

    await waitFor(() => {
      const aboutYouSubmits = trackedEvents('ui_click')
        .map(([, payload]) => payload as Record<string, unknown>)
        .filter((payload) => payload.element === 'about_you_submit');
      expect(aboutYouSubmits).toHaveLength(1);
      expect(aboutYouSubmits[0]).toMatchObject({ role: 'engineer' });
    });
  });

  it('reports about_you_submit exactly once across a Back-then-Continue detour', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    renderOnboarding();

    await continueToAboutYou();
    chooseOnboardingOption('Your role', 'Engineer');

    // About you -> Newsletter
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Stay in the loop' })).toBeTruthy();
    });
    // Back -> About you
    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'About you' })).toBeTruthy();
    });
    // Continue -> Newsletter again, then Brand and finish.
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Stay in the loop' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create once, build everywhere' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build a design system' }));

    // The detour crosses the About-you step twice, but the snapshot must
    // not double-fire.
    await waitFor(() => {
      const aboutYouSubmits = trackedEvents('ui_click')
        .map(([, payload]) => payload as Record<string, unknown>)
        .filter((payload) => payload.element === 'about_you_submit');
      expect(aboutYouSubmits).toHaveLength(1);
    });
  });

  it('does not show a memory-saved callout on the About you step before choices are submitted', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    renderOnboarding();

    await continueToAboutYou();
    expect(screen.queryByText('Saved to your Memory')).toBeNull();
  });
});
