import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { Button } from '@open-design/components';
import {
  agentIdToTracking,
  settingsSectionToTracking,
} from '@open-design/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import {
  trackSettingsAppearanceClick,
  trackSettingsDesignReviewClick,
  trackSettingsLanguageClick,
  trackSettingsLocalCliClick,
  trackSettingsNotificationsClick,
  trackSettingsView,
} from '../analytics/events';
import { LOCALE_LABEL, LOCALES, useI18n } from '../i18n';
import type { Locale } from '../i18n';
import type { Dict } from '../i18n/types';
import { AgentIcon } from './AgentIcon';
import { ExportDiagnosticsRow } from './ExportDiagnosticsButton';
import { Icon } from './Icon';
import {
  CUSTOM_MODEL_SENTINEL,
  SearchableModelSelect,
} from './modelOptions';
import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_ORBIT,
  saveConfig,
  syncConfigToDaemon,
} from '../state/config';
import { navigate as navigateRoute, useRoute } from '../router';
import type {
  AgentInfo,
  AgentModelOption,
  AppConfig,
  AppTheme,
  AppVersionInfo,
  DesignSystemGenerationJob,
  OrbitStatusResponse,
  SkillSummary,
} from '../types';
import {
  fetchConnectors,
  fetchDesignTemplates,
  openExternalUrl,
} from '../providers/registry';
import { Toast } from './Toast';
import {
  checkForUpdaterUpdate,
  deriveUpdaterModel,
  downloadUpdaterUpdate,
  openUpdaterInstaller,
  quitAfterUpdaterInstallerOpen,
  readUpdaterStatus,
  subscribeToUpdaterStatus,
  type UpdaterActionResult,
  type UpdaterModel,
} from '../lib/updater';
import { PetSettings } from './pet/PetSettings';
import { McpClientSection } from './McpClientSection';
import { DesignSystemsSection } from './DesignSystemsSection';
import { PrivacySection } from './PrivacySection';
import { ProjectLocationsSection } from './ProjectLocationsSection';
import { RoutinesSection } from './RoutinesSection';
import { MemoryModelInline } from './MemoryModelInline';
import { MemorySection } from './MemorySection';
import {
  setCritiqueTheaterEnabled,
  useCritiqueTheaterEnabled,
} from './Theater';
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT_COLOR,
  applyAppearanceToDocument,
  normalizeAccentColor,
  resolveAccentColor,
} from '../state/appearance';
import { isAutosaveDraftOnlyChange } from '../App';
import {
  FAILURE_SOUNDS,
  SUCCESS_SOUNDS,
  notificationPermission,
  playSound,
  requestNotificationPermission,
  showCompletionNotification,
} from '../utils/notifications';

export type SettingsSection =
  | 'execution'
  | 'instructions'
  | 'orbit'
  | 'routines'
  | 'integrations'
  | 'mcpClient'
  | 'language'
  | 'appearance'
  | 'critiqueTheater'
  | 'notifications'
  | 'pet'
  | 'designSystems'
  | 'projectLocations'
  | 'memory'
  | 'privacy'
  // 'library' is consumed by the EntryShell library route — App opens it
  // via this same openSettings entry point, so SettingsSection must
  // accept the token even though SettingsDialog itself has no Library
  // section. Reconcile follow-up: route library through a dedicated
  // navigate() call so openSettings only owns dialog-bound sections.
  | 'library'
  | 'about';

// One-shot focus hint when opening the dialog. Reduced to `null` after the
// strip of the AMR coachmark; kept only because callers still thread the
// value through their openSettings plumbing.
export type SettingsHighlight = null;

const OPEN_DESIGN_RELEASES_URL = 'https://github.com/nexu-io/open-design/releases';

type AboutUpdatePrimaryAction = 'check' | 'download' | 'install' | 'quit';
type AboutUpdateTone = 'neutral' | 'success' | 'warning' | 'error';

export interface AboutUpdateControl {
  primaryAction: AboutUpdatePrimaryAction | null;
  primaryLabelKey: keyof Dict | null;
  showReleaseLink: boolean;
  statusKey: keyof Dict;
  statusTone: AboutUpdateTone;
  statusVars?: Record<string, string | number>;
}

export function deriveAboutUpdateControl(
  model: UpdaterModel,
  appVersionInfo: AppVersionInfo | null,
): AboutUpdateControl {
  if (appVersionInfo?.packaged === false) {
    return {
      primaryAction: null,
      primaryLabelKey: null,
      showReleaseLink: true,
      statusKey: 'settings.updateStatusDevelopment',
      statusTone: 'neutral',
    };
  }

  if (model.environment !== 'desktop' || !model.enabled || !model.supported) {
    return {
      primaryAction: null,
      primaryLabelKey: null,
      showReleaseLink: true,
      statusKey: 'settings.updateStatusUnsupported',
      statusTone: 'warning',
    };
  }

  switch (model.status?.state) {
    case 'checking':
      return {
        primaryAction: null,
        primaryLabelKey: 'updater.checking',
        showReleaseLink: true,
        statusKey: 'settings.updateStatusChecking',
        statusTone: 'neutral',
      };
    case 'not-available':
      return {
        primaryAction: 'check',
        primaryLabelKey: 'settings.updateRecheck',
        showReleaseLink: true,
        statusKey: 'settings.updateStatusUpToDate',
        statusTone: 'success',
      };
    case 'available':
      return {
        primaryAction: model.canDownload ? 'download' : null,
        primaryLabelKey: model.canDownload ? 'updater.download' : null,
        showReleaseLink: true,
        statusKey: model.availableVersion
          ? 'settings.updateStatusAvailable'
          : 'settings.updateStatusAvailableUnknown',
        statusTone: 'warning',
        ...(model.availableVersion ? { statusVars: { version: model.availableVersion } } : {}),
      };
    case 'downloading': {
      const percent = model.downloadProgress?.percent;
      return {
        primaryAction: null,
        primaryLabelKey: 'updater.downloading',
        showReleaseLink: true,
        statusKey: typeof percent === 'number'
          ? 'settings.updateStatusDownloadingPercent'
          : 'settings.updateStatusDownloading',
        statusTone: 'neutral',
        ...(typeof percent === 'number' ? { statusVars: { percent } } : {}),
      };
    }
    case 'downloaded': {
      if (model.installerOpened && model.canQuitAfterInstallerOpen) {
        return {
          primaryAction: 'quit',
          primaryLabelKey: 'updater.quitButton',
          showReleaseLink: false,
          statusKey: 'settings.updateQuitFailed',
          statusTone: 'warning',
        };
      }
      const canInstallUpdate = model.canOpenInstaller || model.canApplyInPlace;
      return {
        primaryAction: canInstallUpdate ? 'install' : null,
        primaryLabelKey: canInstallUpdate
          ? model.updateKind === 'payload'
            ? 'updater.installRestart'
            : 'settings.updateNow'
          : null,
        showReleaseLink: true,
        statusKey: model.availableVersion
          ? 'settings.updateStatusReady'
          : 'settings.updateStatusReadyUnknown',
        statusTone: 'success',
        ...(model.availableVersion ? { statusVars: { version: model.availableVersion } } : {}),
      };
    }
    case 'installing':
      return {
        primaryAction: null,
        primaryLabelKey: 'updater.installingRestart',
        showReleaseLink: false,
        statusKey: 'settings.updateStatusInstalling',
        statusTone: 'neutral',
      };
    case 'error':
      return {
        primaryAction: 'check',
        primaryLabelKey: 'settings.updateRetry',
        showReleaseLink: true,
        statusKey: 'settings.updateStatusFailed',
        statusTone: 'error',
      };
    case 'unsupported':
      return {
        primaryAction: null,
        primaryLabelKey: null,
        showReleaseLink: true,
        statusKey: 'settings.updateStatusUnsupported',
        statusTone: 'warning',
      };
    case 'idle':
    default:
      return {
        primaryAction: 'check',
        primaryLabelKey: 'settings.updateCheck',
        showReleaseLink: true,
        statusKey: 'settings.updateStatusNotChecked',
        statusTone: 'neutral',
      };
  }
}

interface Props {
  initial: AppConfig;
  agents: AgentInfo[];
  agentsLoading?: boolean;
  daemonLive?: boolean;
  appVersionInfo: AppVersionInfo | null;
  welcome?: boolean;
  initialSection?: SettingsSection;
  initialHighlight?: SettingsHighlight;
  /**
   * Persist the current draft. Invoked by the dialog's autosave loop on
   * every committed edit. Returns a promise that resolves once both
   * localStorage and the daemon have caught up so the footer status
   * indicator can flip from "Saving…" to "Saved". Should NOT close the
   * dialog and should NOT mutate onboarding state — it represents an
   * incremental save, not a final commit.
   */
  onPersist: (cfg: AppConfig) => Promise<void> | void;
  onClose: () => void;
  onRefreshAgents: (
    options?: AgentRefreshOptions,
  ) => AgentInfo[] | Promise<AgentInfo[] | void> | void;
  onProjectsRefresh?: () => Promise<void> | void;
  /** Same channel for skill registry mutations. */
  onSkillsChanged?: (affectedSkillId?: string) => void;
  /** Same channel for design-system registry mutations. */
  onDesignSystemsChanged?: (affectedDesignSystemId?: string) => void;
  onDesignSystemImportRebuildJob?: (designSystemId: string, job: DesignSystemGenerationJob) => void;
}

export interface AgentRefreshOptions {
  throwOnError?: boolean;
  agentCliEnv?: AppConfig['agentCliEnv'];
}

function sanitizeHttpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

type RescanNotice =
  | { kind: 'success'; count: number }
  | { kind: 'error' };

export function shouldShowCustomModelInput(
  modelValue: string,
  knownModelIds: readonly string[],
  explicitCustomMode: boolean,
): boolean {
  return (
    explicitCustomMode ||
    !modelValue ||
    !knownModelIds.includes(modelValue)
  );
}

const AGENT_SHORT_DESCRIPTIONS: Record<string, string> = {
  claude: 'Anthropic official CLI',
  copilot: 'GitHub coding CLI',
};

function cleanAgentVersionLabel(
  name: string,
  version: string | null | undefined,
): string {
  if (!version) return '';
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return version
    .replace(new RegExp(`\\s*\\(${escapedName}\\)\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s+${escapedName}\\s*$`, 'i'), '')
    .trim();
}

const AGENT_CLI_ENV_FIELDS = [
  {
    agentId: 'claude',
    envKey: 'CLAUDE_CONFIG_DIR',
    labelKey: 'settings.cliEnvClaudeConfigDir',
    placeholder: '~/.claude-2',
  },
  {
    agentId: 'claude',
    envKey: 'ANTHROPIC_BASE_URL',
    labelKey: 'settings.cliEnvClaudeBaseUrl',
    placeholder: 'https://your-proxy.example.com',
  },
] as const;

const AGENT_CLI_AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);
const AGENT_CLI_BASE_URL_ENV_KEYS = new Set(['ANTHROPIC_BASE_URL']);

export function updateAgentCliEnvValue(
  config: AppConfig,
  agentId: string,
  envKey: string,
  rawValue: string,
): AppConfig {
  const value = rawValue.trim();
  const agentCliEnv = { ...(config.agentCliEnv ?? {}) };
  const agentCliEnvIntent = { ...(config.agentCliEnvIntent ?? {}) };
  const nextAgentEnv = { ...(agentCliEnv[agentId] ?? {}) };
  const nextAgentIntent = { ...(agentCliEnvIntent[agentId] ?? {}) };
  if (value) {
    nextAgentEnv[envKey] = value;
  } else {
    delete nextAgentEnv[envKey];
  }

  const hasAuthKey = Object.keys(nextAgentEnv).some((key) => AGENT_CLI_AUTH_ENV_KEYS.has(key));
  if (
    (AGENT_CLI_AUTH_ENV_KEYS.has(envKey) && value) ||
    (AGENT_CLI_BASE_URL_ENV_KEYS.has(envKey) && hasAuthKey)
  ) {
    nextAgentIntent.apiKeyOverride = true;
  } else if (AGENT_CLI_AUTH_ENV_KEYS.has(envKey) && !hasAuthKey) {
    delete nextAgentIntent.apiKeyOverride;
  }

  if (Object.keys(nextAgentEnv).length > 0) {
    agentCliEnv[agentId] = nextAgentEnv;
  } else {
    delete agentCliEnv[agentId];
  }

  if (Object.keys(nextAgentEnv).length > 0 && Object.keys(nextAgentIntent).length > 0) {
    agentCliEnvIntent[agentId] = nextAgentIntent;
  } else {
    delete agentCliEnvIntent[agentId];
  }

  return {
    ...config,
    agentCliEnv: Object.keys(agentCliEnv).length > 0 ? agentCliEnv : {},
    agentCliEnvIntent: Object.keys(agentCliEnvIntent).length > 0 ? agentCliEnvIntent : {},
  };
}

export function agentRefreshOptionsForConfig(cfg: AppConfig): AgentRefreshOptions {
  return {
    throwOnError: true,
    agentCliEnv: cfg.agentCliEnv ?? {},
  };
}

export function SettingsDialog({
  initial,
  agents,
  agentsLoading = false,
  appVersionInfo,
  welcome,
  initialSection = 'execution',
  onPersist,
  onClose,
  onRefreshAgents,
  onProjectsRefresh,
  onDesignSystemsChanged,
  onDesignSystemImportRebuildJob,
}: Props) {
  const { t, locale, setLocale } = useI18n();
  const analytics = useAnalytics();
  const [cfg, setCfg] = useState<AppConfig>(initial);
  const lastSavedAppearanceRef = useRef({
    theme: initial.theme ?? 'system',
    accentColor: resolveAccentColor(initial.accentColor),
  });

  // settings_view — fire on dialog open and on every section switch so the
  // configuration funnel can see which section the user spent time in.
  // The fire is keyed on section so a section bounce (open → switch →
  // close) emits one event per surface.
  const lastViewSectionRef = useRef<string | null>(null);

  useEffect(() => {
    lastSavedAppearanceRef.current = {
      theme: initial.theme ?? 'system',
      accentColor: resolveAccentColor(initial.accentColor),
    };
  }, [initial.theme, initial.accentColor]);

  // Revert the live theme preview to the most recently persisted appearance.
  // That is the initial appearance until autosave succeeds; after autosave,
  // closing Settings must not roll the document back to stale colors.
  useLayoutEffect(() => {
    return () => {
      applyAppearanceToDocument(lastSavedAppearanceRef.current);
    };
  }, []);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [settingsSidebarCollapsed, setSettingsSidebarCollapsed] = useState(false);
  const [settingsFullscreen, setSettingsFullscreen] = useState(false);
  // Scroll the right-hand content pane back to the top whenever the user
  // picks a different settings section. Without this, switching from a
  // long section the user had scrolled (e.g. Library) into a short one
  // (About) keeps the previous scrollTop, so the new section's header
  // can land out of view and the panel reads as half-loaded. Issue #634.
  const settingsContentRef = useRef<HTMLDivElement | null>(null);
  const [agentRescanRunning, setAgentRescanRunning] = useState(false);
  const [agentRescanNotice, setAgentRescanNotice] =
    useState<RescanNotice | null>(null);
  const pendingAgentInstallRescanRef = useRef(false);
  const [agentCustomModelIds, setAgentCustomModelIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [aboutUpdaterModel, setAboutUpdaterModel] = useState<UpdaterModel>(() => deriveUpdaterModel(null));
  const [aboutUpdateActionBusy, setAboutUpdateActionBusy] = useState(false);
  const [aboutToast, setAboutToast] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeToUpdaterStatus((status) => {
      if (!mounted) return;
      setAboutUpdaterModel(deriveUpdaterModel(status, { hostAvailable: true }));
    });
    void readUpdaterStatus({ payload: { source: 'settings-about:mount' } }).then((result) => {
      if (!mounted) return;
      setAboutUpdaterModel(result.ok ? result.model : deriveUpdaterModel(null, { hostAvailable: false }));
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const aboutUpdateControl = useMemo(
    () => deriveAboutUpdateControl(aboutUpdaterModel, appVersionInfo),
    [aboutUpdaterModel, appVersionInfo],
  );

  const applyAboutUpdaterResult = useCallback((result: UpdaterActionResult): boolean => {
    if (!result.ok) {
      setAboutToast(t('settings.updateActionFailed'));
      return false;
    }
    setAboutUpdaterModel(result.model);
    if (result.model.errorMessage != null) {
      setAboutToast(t('settings.updateActionFailed'));
      return false;
    }
    return true;
  }, [t]);

  const handleAboutUpdateAction = useCallback(async () => {
    if (aboutUpdateActionBusy || aboutUpdaterModel.busy || aboutUpdateControl.primaryAction == null) return;
    setAboutUpdateActionBusy(true);
    try {
      const options = { payload: { source: 'settings-about' } };
      if (aboutUpdateControl.primaryAction === 'check') {
        applyAboutUpdaterResult(await checkForUpdaterUpdate(options));
      } else if (aboutUpdateControl.primaryAction === 'download') {
        applyAboutUpdaterResult(await downloadUpdaterUpdate(options));
      } else if (aboutUpdateControl.primaryAction === 'quit') {
        const quitResult = await quitAfterUpdaterInstallerOpen(options);
        if (!quitResult.ok) setAboutToast(t('settings.updateQuitFailed'));
      } else {
        const installed = applyAboutUpdaterResult(await openUpdaterInstaller(options));
        if (installed) {
          const quitResult = await quitAfterUpdaterInstallerOpen(options);
          if (!quitResult.ok) setAboutToast(t('settings.updateQuitFailed'));
        }
      }
    } catch {
      setAboutToast(t('settings.updateActionFailed'));
    } finally {
      setAboutUpdateActionBusy(false);
    }
  }, [
    aboutUpdateActionBusy,
    aboutUpdateControl.primaryAction,
    aboutUpdaterModel.busy,
    applyAboutUpdaterResult,
    t,
  ]);

  const handleOpenReleaseNotes = useCallback(() => {
    void openExternalUrl(OPEN_DESIGN_RELEASES_URL);
  }, []);

  // Precise inverse of App.handleCompleteOnboarding: flip
  // onboardingCompleted back to false, mirror it to localStorage and the
  // daemon through the same config-persist path, then route the user into
  // the first-run flow so they can replay setup (including brand extraction).
  const handleResetOnboarding = useCallback(() => {
    const next: AppConfig = { ...cfg, onboardingCompleted: false };
    setCfg(next);
    saveConfig(next);
    void syncConfigToDaemon(next);
    onClose();
    navigateRoute({ kind: 'home', view: 'onboarding' });
  }, [cfg, onClose]);

  // Imperative handle for the External MCP section. The dialog footer Save
  // routes through this when the MCP tab is active so the user can press the
  // single Save button at the bottom instead of hunting for the inner one.
  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  // settings_view — fires whenever the active section changes (and once on
  // mount). Keying the fire on a section+section-string lets us dedupe
  // accidental double-renders while still capturing genuine tab switches.
  useEffect(() => {
    if (lastViewSectionRef.current === activeSection) return;
    lastViewSectionRef.current = activeSection;
    // v2 settings_view collapses to `{ page=settings, area }`; the
    // execution_mode / has_available_cli / selected_cli_id signal that v1
    // tagged onto every view now lives in the configure-state global
    // properties (registered once and inherited by every event).
    trackSettingsView(analytics.track, {
      page_name: 'settings',
      area: settingsSectionToTracking(activeSection),
    });
  }, [activeSection, analytics.track]);
  useEffect(() => {
    const el = settingsContentRef.current;
    if (el) el.scrollTop = 0;
  }, [activeSection]);

  const selectedMemoryChatAgent =
    cfg.agentId
      ? agents.find((agent) => agent.id === cfg.agentId) ?? null
      : null;
  const selectedMemoryChatModel =
    cfg.agentId
      ? cfg.agentModels?.[cfg.agentId]?.model
      ?? selectedMemoryChatAgent?.models?.[0]?.id
      ?? null
    : null;
  // Rescan notices are list-level feedback for a one-shot action and
  // shouldn't linger in the content stream. After 6s, fade them out so
  // repeated Rescan clicks don't pile up; the next click resets the
  // notice immediately, so this only affects "user moved on" cases.
  useEffect(() => {
    if (!agentRescanNotice) return;
    const id = window.setTimeout(() => setAgentRescanNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [agentRescanNotice]);

  const markAgentInstallIntent = () => {
    pendingAgentInstallRescanRef.current = true;
  };
  const handleRefreshAgents = async () => {
    if (agentRescanRunning) return;
    setAgentRescanRunning(true);
    setAgentRescanNotice(null);
    try {
      const refreshed = await onRefreshAgents(agentRefreshOptionsForConfig(cfg));
      const nextAgents = Array.isArray(refreshed) ? refreshed : agents;
      setAgentRescanNotice({
        kind: 'success',
        count: nextAgents.filter((a) => a.available).length,
      });
    } catch {
      setAgentRescanNotice({ kind: 'error' });
    } finally {
      setAgentRescanRunning(false);
    }
  };
  useEffect(() => {
    const handleReturnToSettings = () => {
      if (
        !pendingAgentInstallRescanRef.current ||
        agentRescanRunning ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      pendingAgentInstallRescanRef.current = false;
      void handleRefreshAgents();
    };
    document.addEventListener('visibilitychange', handleReturnToSettings);
    window.addEventListener('focus', handleReturnToSettings);
    return () => {
      document.removeEventListener('visibilitychange', handleReturnToSettings);
      window.removeEventListener('focus', handleReturnToSettings);
    };
  }, [agentRescanRunning, handleRefreshAgents]);

  // Autosave loop. Every committed edit to `cfg` schedules a debounced
  // sync to localStorage + the daemon. We keep a 400ms debounce so rapid
  // typing in text fields doesn't flood the daemon with PUTs while still
  // feeling near-instant for toggles/selects (which fire once and settle).
  // The status here drives the footer indicator: 'idle' = no draft to
  // flush, 'pending' = scheduled, 'saving' = request in flight, 'saved'
  // = recent successful sync, 'error' = recent failure.
  const [autosaveStatus, setAutosaveStatus] =
    useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  // Skip the very first effect tick so just opening the dialog doesn't
  // appear to "save" anything before the user has touched a field.
  const autosaveSkipFirstRef = useRef(true);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveSavedTimerRef = useRef<number | null>(null);
  const autosavePendingFlushRef = useRef(false);
  const autosaveLatestRef = useRef<AppConfig>(cfg);
  // Baseline used by the draft-only detector: the snapshot at the most
  // recent successful autosave (or the initial cfg on mount). Compared
  // against the current snapshot to decide whether the edits since the
  // last save actually change the persisted shape — if not, we must NOT
  // flash "All changes saved", because nothing was persisted.
  const autosaveLastSavedRef = useRef<AppConfig>(cfg);
  autosaveLatestRef.current = cfg;
  useEffect(() => {
    if (autosaveSkipFirstRef.current) {
      autosaveSkipFirstRef.current = false;
      autosaveLastSavedRef.current = cfg;
      return;
    }
    setAutosaveStatus('pending');
    if (autosaveSavedTimerRef.current != null) {
      window.clearTimeout(autosaveSavedTimerRef.current);
      autosaveSavedTimerRef.current = null;
    }
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosavePendingFlushRef.current = true;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosavePendingFlushRef.current = false;
      autosaveTimerRef.current = null;
      const snapshot = autosaveLatestRef.current;
      // Draft-only edit: the persisted shape would be identical to what
      // is already on disk, so a save would be a no-op that mis-reports
      // "Saved". Skip the persist and settle the indicator to idle.
      if (isAutosaveDraftOnlyChange(snapshot, autosaveLastSavedRef.current)) {
        setAutosaveStatus('idle');
        return;
      }
      setAutosaveStatus('saving');
      void (async () => {
        try {
          await onPersist(snapshot);
          autosaveLastSavedRef.current = snapshot;
          lastSavedAppearanceRef.current = {
            theme: snapshot.theme ?? 'system',
            accentColor: resolveAccentColor(snapshot.accentColor),
          };
          // If a newer edit landed while the request was in flight,
          // leave the status as 'pending' so the next debounce tick
          // owns the indicator instead of flashing "Saved".
          if (autosaveLatestRef.current !== snapshot) {
            setAutosaveStatus('pending');
            return;
          }
          setAutosaveStatus('saved');
          autosaveSavedTimerRef.current = window.setTimeout(() => {
            autosaveSavedTimerRef.current = null;
            // Settle to idle after a moment so the indicator doesn't
            // stay on "Saved" forever and become noise.
            setAutosaveStatus((curr) => (curr === 'saved' ? 'idle' : curr));
          }, 1800);
        } catch {
          setAutosaveStatus('error');
        }
      })();
    }, 400);
    return () => {
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [cfg, onPersist]);
  // Flush any pending autosave on unmount so a fast-closing dialog
  // never strands an in-flight edit. We also clear the "Saved" toast
  // timer to avoid setState after unmount.
  useEffect(() => {
    return () => {
      if (autosavePendingFlushRef.current) {
        // Best-effort flush; if it rejects, localStorage already has
        // the latest copy from the synchronous saveConfig call inside
        // onPersist.
        autosavePendingFlushRef.current = false;
        void Promise.resolve(onPersist(autosaveLatestRef.current)).catch(() => undefined);
      }
      if (autosaveSavedTimerRef.current != null) {
        window.clearTimeout(autosaveSavedTimerRef.current);
        autosaveSavedTimerRef.current = null;
      }
    };
  }, [onPersist]);

  // Global Escape closes the dialog. With no footer button anymore the
  // close affordances are: top-right X · backdrop click · Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Header title/subtitle follow the active sidebar section so the dialog
  // header always reflects what the user is looking at, instead of being
  // pinned to one section's copy.
  const sectionHeader: Record<SettingsSection, { title: string; subtitle: string }> = {
    execution: { title: t('settings.title'), subtitle: t('settings.subtitle') },
    instructions: {
      title: t('settings.instructionsTitle'),
      subtitle: t('settings.instructionsSubtitle'),
    },
    orbit: { title: t('settings.orbit.title'), subtitle: t('settings.orbit.lede') },
    routines: {
      title: t('routines.title'),
      subtitle: t('routines.subtitle'),
    },
    integrations: { title: t('settings.mcpServerTitle'), subtitle: t('settings.mcpServerHint') },
    mcpClient: { title: t('settings.externalMcpTitle'), subtitle: t('settings.externalMcpHint') },
    language: { title: t('settings.language'), subtitle: t('settings.languageHint') },
    appearance: { title: t('settings.appearance'), subtitle: t('settings.appearanceHint') },
    critiqueTheater: {
      title: t('critiqueTheater.settingsNav'),
      subtitle: t('critiqueTheater.settingsNavHint'),
    },
    notifications: { title: t('settings.notifications'), subtitle: t('settings.notificationsHint') },
    privacy: { title: t('settings.privacy'), subtitle: t('settings.privacyHint') },
    pet: { title: t('pet.title'), subtitle: t('pet.subtitle') },
    designSystems: {
      title: t('settings.designSystems'),
      subtitle: t('settings.designSystemsHint'),
    },
    projectLocations: {
      title: t('settings.projectLocations'),
      subtitle: t('settings.projectLocationsHint'),
    },
    memory: { title: t('settings.memory'), subtitle: t('settings.memoryHint') },
    // 'library' is opened via EntryShell route — SettingsDialog doesn't
    // render it but SettingsSection must accept the token (see type def).
    library: { title: '', subtitle: '' },
    about: { title: t('settings.about'), subtitle: t('settings.aboutHint') },
  };
  const activeHeader = sectionHeader[activeSection];
  const installedAgents = agents.filter((a) => a.available);
  const unavailableAgents = agents.filter((a) => !a.available);
  const initialAgentScanRunning = agentsLoading && agents.length === 0;
  const agentModelOptionLabel = (
    model: AgentModelOption | undefined,
    fallback: string,
  ) => {
    if (!model) return fallback;
    const label = model.label?.trim();
    const id = model.id.trim();
    if (label && label !== id) {
      return label.toLowerCase().includes(id.toLowerCase())
        ? label
        : `${label} (${id})`;
    }
    return label || id;
  };
  const agentModelSummary = (agent: AgentInfo) => {
    if (!Array.isArray(agent.models) || agent.models.length === 0) return null;
    const choice = cfg.agentModels?.[agent.id] ?? {};
    const modelValue = choice.model ?? agent.models[0]?.id ?? '';
    if (!modelValue) return t('settings.modelCustom');
    return agentModelOptionLabel(
      agent.models.find((m) => m.id === modelValue),
      modelValue,
    );
  };
  const renderAgentModelConfig = (selected: AgentInfo) => {
    const hasModels =
      Array.isArray(selected.models) && selected.models.length > 0;
    const hasReasoning =
      Array.isArray(selected.reasoningOptions) &&
      selected.reasoningOptions.length > 0;
    if (!hasModels && !hasReasoning) return null;
    const choice = cfg.agentModels?.[selected.id] ?? {};
    const knownModelIds = selected.models?.map((m) => m.id) ?? [];
    // Adapters opt out via `supportsCustomModel: false` on their
    // RuntimeAgentDef when their CLI has no `--model` flag. Undefined ===
    // allow, matching today's UX.
    const allowCustomModel = selected.supportsCustomModel !== false;
    const configuredModel =
      typeof choice.model === 'string' && choice.model
        ? choice.model
        : null;
    const setChoice = (
      next: { model?: string; reasoning?: string },
    ) => {
      setCfg((c) => {
        const prev = c.agentModels?.[selected.id] ?? {};
        return {
          ...c,
          agentModels: {
            ...(c.agentModels ?? {}),
            [selected.id]: { ...prev, ...next },
          },
        };
      });
    };
    const modelValue = configuredModel ?? selected.models?.[0]?.id ?? '';
    const reasoningValue =
      choice.reasoning ??
      selected.reasoningOptions?.[0]?.id ?? '';
    const customActive =
      allowCustomModel &&
      hasModels &&
      shouldShowCustomModelInput(
        modelValue,
        knownModelIds,
        agentCustomModelIds.has(selected.id),
      );
    const selectValue = customActive
      ? CUSTOM_MODEL_SENTINEL
      : modelValue;
    const modelSource = selected.modelsSource ?? 'fallback';
    const modelSourceLabel =
      modelSource === 'live'
        ? t('settings.modelSourceLive')
        : t('settings.modelSourceFallback');
    const modelSourceHint =
      modelSource === 'live'
        ? selected.supportsCustomModel === false
          ? t('settings.modelPickerLiveCatalogOnlyHint')
          : t('settings.modelPickerLiveHint')
        : t('settings.modelPickerFallbackHint');
    return (
      <div className="agent-card-config">
        {hasModels ? (
          <>
            <label className="field">
              <span className="field-label">
                {t('settings.modelPicker')}
                <span
                  className={`agent-model-source-badge ${modelSource}`}
                  aria-hidden="true"
                >
                  {modelSourceLabel}
                </span>
              </span>
              <div className="agent-model-select-wrap">
                <SearchableModelSelect
                  className="inline-switcher__select settings-model-select"
                  value={selectValue}
                  aria-label={t('settings.modelPicker')}
                  searchPlaceholder={t('designs.searchPlaceholder')}
                  searchInputTestId={`settings-agent-model-search-${selected.id}`}
                  popoverTestId={`settings-agent-model-popover-${selected.id}`}
                  minSearchableOptions={5}
                  popoverMinWidth={340}
                  models={selected.models!}
                  onChange={(nextValue) => {
                    if (nextValue === CUSTOM_MODEL_SENTINEL) {
                      setAgentCustomModelIds((prev) => {
                        const next = new Set(prev);
                        next.add(selected.id);
                        return next;
                      });
                      setChoice({ model: '' });
                    } else {
                      setAgentCustomModelIds((prev) => {
                        if (!prev.has(selected.id)) return prev;
                        const next = new Set(prev);
                        next.delete(selected.id);
                        return next;
                      });
                      setChoice({ model: nextValue });
                    }
                  }}
                  additionalOptions={
                    allowCustomModel
                      ? [
                          {
                            value: CUSTOM_MODEL_SENTINEL,
                            label: t('settings.modelCustom'),
                          },
                        ]
                      : undefined
                  }
                />
              </div>
            </label>
            <p className="hint agent-model-row-hint">
              {modelSourceHint}
            </p>
          </>
        ) : null}
        {customActive ? (
          <label className="field">
            <span className="field-label">
              {t('settings.modelCustomLabel')}
            </span>
            <input
              type="text"
              value={modelValue}
              placeholder={t('settings.modelCustomPlaceholder')}
              onChange={(e) =>
                setChoice({ model: e.target.value.trim() })
              }
            />
          </label>
        ) : null}
        {hasReasoning ? (
          <label className="field">
            <span className="field-label">
              {t('settings.reasoningPicker')}
            </span>
            <div className="agent-model-select-wrap">
              <select
                value={reasoningValue}
                onChange={(e) =>
                  setChoice({ reasoning: e.target.value })
                }
              >
                {selected.reasoningOptions!.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <Icon
                name="chevron-down"
                size={12}
                className="agent-model-select-chevron"
              />
            </div>
          </label>
        ) : null}
      </div>
    );
  };

  const settingsSidebarToggleLabel = settingsSidebarCollapsed
    ? 'Expand settings sidebar'
    : 'Collapse settings sidebar';
  const settingsFullscreenLabel = settingsFullscreen
    ? t('common.exitFullscreen')
    : t('common.fullscreen');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={
          'modal modal-settings' +
          (settingsSidebarCollapsed ? ' settings-sidebar-collapsed' : '') +
          (settingsFullscreen ? ' settings-fullscreen' : '')
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top-right chrome strip — anchored to the modal corner so the
            autosave indicator and the close button float above the
            sidebar/content rhythm without competing with the title.
            We use `position: absolute` instead of putting these inside
            `.modal-head` so the welcome variant's tall hero (kicker /
            title / subtitle / pet teaser) keeps its centred reading
            measure, and the close button always lands at the same
            optical location regardless of how much copy the header
            renders. */}
        <div className="settings-chrome" aria-hidden={false}>
          {/* Autosave status pill. Only renders something while a save
              is in flight or has just completed — idle = invisible so
              first-open feels calm. The chrome strip itself stays
              mounted so the close button never shifts when the pill
              appears, and the pill is announced via aria-live for
              assistive tech. */}
          <div
            className={`settings-autosave is-${autosaveStatus}`}
            role="status"
            aria-live="polite"
          >
            {autosaveStatus === 'saving' || autosaveStatus === 'pending' ? (
              <>
                <Icon name="spinner" size={12} className="icon-spin" />
                <span>{t('settings.autosaveSaving')}</span>
              </>
            ) : autosaveStatus === 'saved' ? (
              <>
                <Icon name="check" size={12} />
                <span>{t('settings.autosaveSaved')}</span>
              </>
            ) : autosaveStatus === 'error' ? (
              <>
                <Icon name="close" size={12} />
                <span>{t('settings.autosaveError')}</span>
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="settings-chrome-btn settings-fullscreen-toggle"
            onClick={() => setSettingsFullscreen((current) => !current)}
            aria-label={settingsFullscreenLabel}
            aria-pressed={settingsFullscreen}
            title={settingsFullscreenLabel}
          >
            <Icon
              name={settingsFullscreen ? 'minimize' : 'maximize'}
              size={15}
              strokeWidth={2}
            />
          </button>
          <button
            type="button"
            className="settings-chrome-btn settings-close"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <Icon name="close" size={16} strokeWidth={2} />
          </button>
        </div>
        <header className="modal-head" id="settings-dialog-title">
          {welcome ? (
            <>
              <span className="kicker">{t('settings.welcomeKicker')}</span>
              <h2>{t('settings.welcomeTitle')}</h2>
              <p className="subtitle">{t('settings.welcomeSubtitle')}</p>
            </>
          ) : (
            <>
              <span className="kicker">{t('settings.kicker')}</span>
              <div className="modal-head-line">
                <h2>{activeHeader.title}</h2>
                <p className="subtitle">{activeHeader.subtitle}</p>
              </div>
            </>
          )}
        </header>

        <div className="modal-body">
          <button
            type="button"
            className="settings-sidebar-toggle"
            onClick={() => setSettingsSidebarCollapsed((current) => !current)}
            aria-label={settingsSidebarToggleLabel}
            aria-pressed={settingsSidebarCollapsed}
            aria-controls="settings-sidebar"
            title={settingsSidebarToggleLabel}
          >
            <Icon
              name={settingsSidebarCollapsed ? 'chevron-right' : 'chevron-left'}
              size={15}
              strokeWidth={2}
            />
          </button>
          <aside
            id="settings-sidebar"
            className="settings-sidebar"
            aria-label="Settings sections"
            aria-hidden={settingsSidebarCollapsed ? true : undefined}
          >
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'execution' ? ' active' : ''}`}
              onClick={() => setActiveSection('execution')}
            >
              <Icon name="sliders" size={18} />
              <span>
                <strong>{t('settings.envConfigure')}</strong>
                <small>{`${t('settings.localCli')} / ${t('settings.modeApiMeta')}`}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'instructions' ? ' active' : ''}`}
              onClick={() => setActiveSection('instructions')}
            >
              <Icon name="edit" size={18} />
              <span>
                <strong>{t('settings.instructionsTitle')}</strong>
                <small>{t('settings.instructionsNavSub')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'memory' ? ' active' : ''}`}
              onClick={() => setActiveSection('memory')}
            >
              <Icon name="history" size={18} />
              <span>
                <strong>{t('settings.memory')}</strong>
                <small>{t('settings.memoryHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'mcpClient' ? ' active' : ''}`}
              onClick={() => setActiveSection('mcpClient')}
            >
              <Icon name="sparkles" size={18} />
              <span>
                <strong>{t('settings.externalMcpTitle')}</strong>
                <small>{t('settings.externalMcpHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'integrations' ? ' active' : ''}`}
              onClick={() => setActiveSection('integrations')}
            >
              <Icon name="link" size={18} />
              <span>
                <strong>{t('settings.mcpServerTitle')}</strong>
                <small>{t('settings.mcpServerHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'language' ? ' active' : ''}`}
              onClick={() => setActiveSection('language')}
            >
              <Icon name="languages" size={18} />
              <span>
                <strong>{t('settings.language')}</strong>
                <small>{t('settings.languageHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'appearance' ? ' active' : ''}`}
              onClick={() => setActiveSection('appearance')}
            >
              <Icon name="sun-moon" size={18} />
              <span>
                <strong>{t('settings.appearance')}</strong>
                <small>{t('settings.appearanceHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'critiqueTheater' ? ' active' : ''}`}
              onClick={() => setActiveSection('critiqueTheater')}
            >
              <Icon name="comment" size={18} />
              <span>
                <strong>{t('critiqueTheater.settingsNav')}</strong>
                <small>{t('critiqueTheater.settingsNavHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'notifications' ? ' active' : ''}`}
              onClick={() => setActiveSection('notifications')}
            >
              <Icon name="bell" size={18} />
              <span>
                <strong>{t('settings.notifications')}</strong>
                <small>{t('settings.notificationsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'pet' ? ' active' : ''}`}
              onClick={() => setActiveSection('pet')}
            >
              <Icon name="sparkles" size={18} />
              <span>
                <strong>{t('pet.navTitle')}</strong>
                <small>{t('pet.navHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'designSystems' ? ' active' : ''}`}
              onClick={() => setActiveSection('designSystems')}
            >
              <Icon name="draw" size={18} />
              <span>
                <strong>{t('settings.designSystems')}</strong>
                <small>{t('settings.designSystemsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'projectLocations' ? ' active' : ''}`}
              onClick={() => setActiveSection('projectLocations')}
            >
              <Icon name="folder" size={18} />
              <span>
                <strong>{t('settings.projectLocations')}</strong>
                <small>{t('settings.projectLocationsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'privacy' ? ' active' : ''}`}
              onClick={() => setActiveSection('privacy')}
            >
              <Icon name="eye" size={18} />
              <span>
                <strong>{t('settings.privacy')}</strong>
                <small>{t('settings.privacyHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'about' ? ' active' : ''}`}
              onClick={() => setActiveSection('about')}
            >
              <Icon name="settings" size={18} />
              <span>
                <strong>{t('settings.about')}</strong>
                <small>{t('settings.aboutHint')}</small>
              </span>
            </button>
          </aside>
          <div className="settings-content" ref={settingsContentRef}>
          {activeSection === 'execution' ? (
            <section className="settings-section">
              <div className="section-head">
                <div>
                  <p className="hint">{t('settings.codeAgentHint')}</p>
                </div>
              </div>
              {initialAgentScanRunning ? (
                <div className="agent-scan-card" role="status" aria-live="polite">
                  <div className="agent-scan-card__stage">
                    <span className="agent-scan-card__ring" aria-hidden />
                    <strong>{t('settings.rescanRunning')}</strong>
                    <span>{t('settings.codeAgentHint')}</span>
                    <div className="agent-scan-card__progress" aria-hidden>
                      <span />
                    </div>
                  </div>
                  <div className="agent-scan-card__rows" aria-hidden>
                    <span><i /><b /><em /></span>
                    <span><i /><b /><em /></span>
                    <span><i /><b /><em /></span>
                  </div>
                </div>
              ) : agents.length === 0 ? (
                <div className="empty-card">
                  {t('settings.noAgentsDetected')}
                </div>
              ) : (
                <>
                  <div className="agent-group">
                    <div className="agent-group-head">
                      <h4>
                        {t('settings.agentInstalledGroup', {
                          count: installedAgents.length,
                        })}
                      </h4>
                      <div className="agent-group-head-actions">
                        {agentRescanNotice ? (
                          <span
                            className={
                              'settings-rescan-status settings-rescan-status-inline ' +
                              agentRescanNotice.kind
                            }
                            role={
                              agentRescanNotice.kind === 'error'
                                ? 'alert'
                                : 'status'
                            }
                          >
                            {agentRescanNotice.kind === 'success'
                              ? t('settings.rescanSuccess', {
                                  count: agentRescanNotice.count,
                                })
                              : t('settings.rescanFailed')}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={
                            'ghost icon-btn settings-rescan-btn agent-group-rescan-btn' +
                            (agentRescanRunning ? ' loading' : '')
                          }
                          onClick={() => void handleRefreshAgents()}
                          disabled={agentRescanRunning}
                          title={t('settings.rescanTitle')}
                        >
                          {agentRescanRunning ? (
                            <>
                              <Icon
                                name="spinner"
                                size={13}
                                className="icon-spin"
                              />
                              <span>{t('settings.rescanRunning')}</span>
                            </>
                          ) : (
                            t('settings.rescan')
                          )}
                        </button>
                      </div>
                    </div>
                    {installedAgents.length > 0 ? (
                      <div className="agent-grid agent-grid-installed">
                        {installedAgents.map((a) => {
                          const active = cfg.agentId === a.id;
                          const description = AGENT_SHORT_DESCRIPTIONS[a.id];
                          const modelSummary = agentModelSummary(a);
                          const versionLabel = cleanAgentVersionLabel(a.name, a.version);
                          const metaLabel =
                            a.authStatus === 'missing'
                              ? t('settings.agentAuthRequired')
                              : a.authStatus === 'unknown'
                                ? t('settings.agentAuthUnknown')
                                : versionLabel
                                  ? versionLabel
                                  : t('common.installed');
                          const metaTitle =
                            a.authStatus === 'missing' ||
                            a.authStatus === 'unknown'
                              ? (a.authMessage ?? a.path ?? '')
                              : (a.path ?? '');
                          return (
                            <div
                              key={a.id}
                              data-testid={`settings-agent-card-${a.id}`}
                              className={
                                'agent-card agent-card-installed' +
                                (active ? ' active' : '')
                              }
                            >
                              <div className="agent-card-main">
                                <button
                                  type="button"
                                  className="agent-card-select"
                                  data-testid={`settings-agent-select-${a.id}`}
                                  onClick={() => {
                                    trackSettingsLocalCliClick(analytics.track, {
                                      page_name: 'settings',
                                      area: 'configure_execution_mode_local_cli',
                                      element: 'cli_provider',
                                      cli_provider_id: agentIdToTracking(a.id),
                                      install_status: 'installed',
                                    });
                                    setCfg((c) => ({ ...c, agentId: a.id }));
                                  }}
                                  aria-pressed={active}
                                >
                                  <AgentIcon id={a.id} size={32} />
                                  <div className="agent-card-body">
                                    <div className="agent-card-name">
                                      <span className="agent-card-title">
                                        {a.name}
                                      </span>
                                      {description ? (
                                        <>
                                          <span
                                            className="agent-card-name-divider"
                                            aria-hidden="true"
                                          >
                                            ·
                                          </span>
                                          <span className="agent-card-tagline">
                                            {description}
                                          </span>
                                        </>
                                      ) : null}
                                    </div>
                                    {metaLabel ? (
                                      <div className="agent-card-meta">
                                        <span title={metaTitle}>
                                          {metaLabel}
                                        </span>
                                      </div>
                                    ) : null}
                                    {!active && modelSummary ? (
                                      <div className="agent-card-model-summary">
                                        <span>{t('settings.modelPicker')}</span>
                                        <strong>{modelSummary}</strong>
                                      </div>
                                    ) : null}
                                  </div>
                                </button>
                              </div>
                              {active ? renderAgentModelConfig(a) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="empty-card">
                        {t('settings.noAgentsDetected')}
                      </div>
                    )}
                  </div>
                  {unavailableAgents.length > 0 ? (
                    <details
                      className="agent-install-collapse"
                      open={installedAgents.length > 0 ? undefined : true}
                    >
                      <summary className="agent-install-collapse-summary">
                        <span>
                          {t('settings.agentInstallGroup', {
                            count: unavailableAgents.length,
                          })}
                        </span>
                      </summary>
                      <div className="agent-grid agent-grid-unavailable">
                        {unavailableAgents.map((a) => {
                          const installUrl = sanitizeHttpsUrl(a.installUrl);
                          const docsUrl = sanitizeHttpsUrl(a.docsUrl);
                          const hasLinks = Boolean(installUrl || docsUrl);
                          const description = AGENT_SHORT_DESCRIPTIONS[a.id];
                          const cardLabel = `${a.name} · ${t('common.notInstalled')}`;
                          return (
                            <div
                              key={a.id}
                              className="agent-card disabled agent-card-unavailable"
                              role="group"
                              aria-label={cardLabel}
                            >
                              <div className="agent-card-unavailable-row">
                                <AgentIcon id={a.id} size={30} />
                                <div className="agent-card-body">
                                  <div className="agent-card-name">
                                    {a.name}
                                  </div>
                                  {description ? (
                                    <div className="agent-card-description">
                                      {description}
                                    </div>
                                  ) : null}
                                </div>
                                {hasLinks ? (
                                  <div className="agent-card-actions agent-card-actions--inline">
                                    {docsUrl ? (
                                      <a
                                        href={docsUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="agent-card-link agent-card-link--muted agent-card-link--icon"
                                        onClick={markAgentInstallIntent}
                                        title={t('settings.agentInstall.docs')}
                                        aria-label={t('settings.agentInstall.docs')}
                                      >
                                        <Icon name="file" size={15} />
                                      </a>
                                    ) : null}
                                    {installUrl ? (
                                      <a
                                        href={installUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="agent-card-link agent-card-link--ghost"
                                        onClick={markAgentInstallIntent}
                                      >
                                        {t('settings.agentInstall.install')}
                                      </a>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                  {/*
                    Show the install guide only when the user has *no*
                    working agent picked yet. Older logic surfaced it
                    whenever any agent on the support list was missing,
                    which fired for almost everyone (few people install
                    all 14 supported CLIs) — the four-step quickstart
                    then sat between the agent grid and the model picker
                    forever, even after the user had successfully picked
                    Claude Code months ago. Once a working agent is
                    selected, the guide has done its job and only adds
                    noise.
                  */}
                  {!agents.find(
                    (a) => a.id === cfg.agentId && a.available,
                  ) ? (
                    <div className="agent-install-guide">
                      <p className="hint agent-install-path-hint">
                        {t('settings.agentInstall.pathHint')}
                      </p>
                      <ol className="agent-install-steps">
                        <li>{t('settings.agentInstall.stepOpenLinks')}</li>
                        <li>{t('settings.agentInstall.stepAuth')}</li>
                        <li>{t('settings.agentInstall.stepRescan')}</li>
                        <li>{t('settings.agentInstall.stepSelect')}</li>
                      </ol>
                    </div>
                  ) : null}
                </>
              )}
              {(() => {
                const selected = agents.find(
                  (a) => a.id === cfg.agentId && a.available,
                );
                if (!selected) return null;
                const hasModels =
                  Array.isArray(selected.models) && selected.models.length > 0;
                const choice = cfg.agentModels?.[selected.id] ?? {};
                const configuredModel =
                  typeof choice.model === 'string' && choice.model
                    ? choice.model
                    : null;
                const modelValue =
                  configuredModel ?? selected.models?.[0]?.id ?? '';
                return (
                  <details className="agent-cli-env settings-memory-advanced">
                    <summary className="agent-cli-env-summary">
                      <span className="agent-cli-env-summary-title">
                        {t('settings.memoryModelInlineLabel')}
                      </span>
                    </summary>
                    <div className="agent-cli-env-body">
                      <MemoryModelInline
                        chatModel={modelValue}
                        cliAgentId={selected.id}
                        cliModelOptions={
                          hasModels ? selected.models!.map((m) => m.id) : []
                        }
                      />
                    </div>
                  </details>
                );
              })()}
              {(() => {
                /*
                  Per-agent CLI environment overrides — proxy URLs, custom
                  config dirs, and a binary path override. The previous
                  layout listed every supported agent's variables in one
                  long always-expanded block; for users on Claude Code
                  the Codex fields were just visual filler (and vice
                  versa), and the section hijacked Settings real estate
                  on every open even though nine in ten users never
                  touch it. Now: filtered to the *currently selected*
                  agent only, and folded into a collapsed disclosure
                  that opens to "Advanced: proxy & custom paths" — power
                  users who route through LiteLLM or installed the
                  binary out-of-PATH still have one click access; new
                  users no longer wonder "are these fields I forgot to
                  fill in?".
                */
                const cliEnvFields = AGENT_CLI_ENV_FIELDS.filter(
                  (field) => field.agentId === cfg.agentId,
                );
                if (cliEnvFields.length === 0) return null;
                return (
                  <details
                    className="agent-cli-env"
                    data-testid="settings-cli-env"
                  >
                    <summary className="agent-cli-env-summary">
                      <span className="agent-cli-env-summary-title">
                        {t('settings.cliEnvTitle')}
                      </span>
                    </summary>
                    <div className="agent-cli-env-body">
                      <p className="hint">{t('settings.cliEnvHint')}</p>
                      <div className="agent-cli-env-grid">
                        {cliEnvFields.map((field) => (
                          <label
                            className="field"
                            key={`${field.agentId}:${field.envKey}`}
                          >
                            <span className="field-label">
                              {t(field.labelKey)}
                            </span>
                            <input
                              type="text"
                              value={
                                cfg.agentCliEnv?.[field.agentId]?.[
                                  field.envKey
                                ] ?? ''
                              }
                              placeholder={field.placeholder}
                              spellCheck={false}
                              autoComplete="off"
                              onChange={(e) =>
                                setCfg((c) =>
                                  updateAgentCliEnvValue(
                                    c,
                                    field.agentId,
                                    field.envKey,
                                    e.target.value,
                                  ),
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </details>
                );
              })()}
            </section>
          ) : null}

          {activeSection === 'integrations' ? <IntegrationsSection /> : null}

          {activeSection === 'mcpClient' ? <McpClientSection surface="settings" /> : null}

          {activeSection === 'routines' ? <RoutinesSection onClose={onClose} /> : null}

          {activeSection === 'orbit' ? (
            <OrbitSection
              cfg={cfg}
              setCfg={setCfg}
              onOpenConnectors={() => {
                // The connectors catalog lives on the Integrations page
                // after the Composio API-key section was removed from
                // Settings; close the dialog and route there.
                onClose();
                navigateRoute({ kind: 'home', view: 'integrations' });
              }}
              onLeaveForOrbitProject={(runConfig) => {
                // Persist any in-flight Orbit edits (toggle / time) before
                // navigating away so they aren't silently lost. The autosave
                // loop is best-effort; this synchronous flush guarantees the
                // run-config landed on the daemon before we tear the dialog
                // down. Closing the dialog drops the user on the
                // /projects/orbit view where the agent run streams in.
                void onPersist(runConfig);
                onClose();
              }}
            />
          ) : null}

          {activeSection === 'language' ? (
          <section className="settings-section">
            <div className="settings-language-grid" role="radiogroup" aria-label={t('settings.language')}>
              {LOCALES.map((code) => {
                const active = locale === code;
                return (
                  <button
                    key={code}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`settings-language-tile${active ? ' active' : ''}`}
                    onClick={() => {
                      // P1 ui_click area=language — record the locale id
                      // that was picked, regardless of whether it differs
                      // from the current one (user clicked = signal).
                      trackSettingsLanguageClick(analytics.track, {
                        page_name: 'settings',
                        area: 'language',
                        element: code,
                      });
                      setLocale(code as Locale);
                    }}
                  >
                    <span className="settings-language-tile-text">
                      <span className="settings-language-tile-title">
                        {LOCALE_LABEL[code]}
                      </span>
                      <span className="settings-language-tile-code">
                        {code}
                      </span>
                    </span>
                    {active ? <Icon name="check" size={16} /> : null}
                  </button>
                );
              })}
            </div>
          </section>
          ) : null}

          {activeSection === 'appearance' ? (
            <AppearanceSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'critiqueTheater' ? (
            <CritiqueTheaterSection />
          ) : null}

          {activeSection === 'notifications' ? (
            <NotificationsSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'pet' ? (
            <PetSettings cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'designSystems' ? (
            <DesignSystemsSection
              cfg={cfg}
              setCfg={setCfg}
              onDesignSystemsChanged={onDesignSystemsChanged}
              onDesignSystemImportRebuildJob={onDesignSystemImportRebuildJob}
            />
          ) : null}

          {activeSection === 'projectLocations' ? (
            <ProjectLocationsSection cfg={cfg} setCfg={setCfg} onProjectsRefresh={onProjectsRefresh} />
          ) : null}

          {activeSection === 'instructions' ? (
            <section className="settings-section settings-section-card instructions-rules-section">
              <div className="memory-field-block instructions-rules-card">
                <div className="memory-block-head">
                  <div>
                    <h4>{t('settings.customInstructionsTitle')}</h4>
                    <p className="hint">
                      {t('settings.customInstructionsDesc')}
                    </p>
                  </div>
                </div>
                <textarea
                  className="custom-instructions-input memory-global-rules-input instructions-rules-input"
                  rows={5}
                  maxLength={5000}
                  placeholder={t('settings.customInstructionsPlaceholder')}
                  value={cfg.customInstructions ?? ''}
                  onChange={(event) =>
                    setCfg({
                      ...cfg,
                      customInstructions: event.target.value || undefined,
                    })
                  }
                />
              </div>
            </section>
          ) : null}

          {activeSection === 'memory' ? (
            <MemorySection
              onOpenConnectors={() => {
                onClose();
                navigateRoute({ kind: 'home', view: 'integrations' });
              }}
              chatAgentId={cfg.agentId ?? null}
              chatModel={selectedMemoryChatModel}
            />
          ) : null}

          {activeSection === 'privacy' ? (
            <PrivacySection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'about' ? (
            <section className="settings-section">
              {appVersionInfo ? (
                <dl className="settings-about-list">
                  <div className="settings-about-version-row">
                    <div className="settings-about-version-copy">
                      <div className="settings-about-version-left">
                        <dt>{t('settings.appVersion')}</dt>
                        <span className="settings-about-version-num">{appVersionInfo.version}</span>
                        <dd
                          aria-live="polite"
                          className={`settings-about-update-status settings-about-update-status--${aboutUpdateControl.statusTone}`}
                        >
                          {t(aboutUpdateControl.statusKey, aboutUpdateControl.statusVars)}
                        </dd>
                      </div>
                    </div>
                    <div className="settings-about-update-actions">
                      {aboutUpdateControl.primaryLabelKey ? (
                        <button
                          type="button"
                          className={`settings-about-update-button${
                            aboutUpdateControl.primaryAction === 'download'
                              || aboutUpdateControl.primaryAction === 'install'
                              || aboutUpdateControl.primaryAction === 'quit'
                              ? ' settings-about-update-button--primary'
                              : ''
                          }`}
                          disabled={
                            aboutUpdateActionBusy
                            || aboutUpdaterModel.busy
                            || aboutUpdateControl.primaryAction == null
                          }
                          onClick={handleAboutUpdateAction}
                        >
                          {aboutUpdateActionBusy
                            ? t('common.loading')
                            : t(aboutUpdateControl.primaryLabelKey)}
                        </button>
                      ) : null}
                      {aboutUpdateControl.showReleaseLink ? (
                        <button
                          type="button"
                          className="settings-about-release-link"
                          onClick={handleOpenReleaseNotes}
                        >
                          {t('settings.updateViewReleases')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div>
                    <dt>{t('settings.appChannel')}</dt>
                    <dd>{appVersionInfo.channel}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.appRuntime')}</dt>
                    <dd>
                      {appVersionInfo.packaged
                        ? t('settings.runtimePackaged')
                        : t('settings.runtimeDevelopment')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('settings.appPlatform')}</dt>
                    <dd>{appVersionInfo.platform}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.appArchitecture')}</dt>
                    <dd>{appVersionInfo.arch}</dd>
                  </div>
                </dl>
              ) : (
                <div className="empty-card">{t('settings.versionUnavailable')}</div>
              )}
              <div className="settings-about-diagnostics">
                <div className="settings-about-diagnostics-text">
                  <h4>{t('diagnostics.exportTitle')}</h4>
                  <p className="hint">{t('diagnostics.exportHint')}</p>
                </div>
                <ExportDiagnosticsRow />
              </div>
              <div className="settings-about-diagnostics">
                <div className="settings-about-diagnostics-text">
                  <h4>{t('settings.resetOnboarding')}</h4>
                  <p className="hint">{t('settings.resetOnboardingDesc')}</p>
                </div>
                <Button onClick={handleResetOnboarding}>
                  {t('settings.resetOnboardingButton')}
                </Button>
              </div>
            </section>
          ) : null}
          {aboutToast ? (
            <Toast
              message={aboutToast}
              onDismiss={() => setAboutToast(null)}
            />
          ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

interface OrbitRunStartResponse {
  projectId: string;
  agentRunId: string;
}

export async function persistConfigAndRunOrbit(
  config: AppConfig,
  options?: {
    locale?: string | null;
  },
): Promise<OrbitRunStartResponse> {
  await syncConfigToDaemon(config, { throwOnError: true });
  const response = await fetch('/api/orbit/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: options?.locale ?? null }),
  });
  if (!response.ok) throw new Error('Orbit run failed');
  return await response.json() as OrbitRunStartResponse;
}

export function configForManualOrbitRun(config: AppConfig): AppConfig {
  const effectiveTemplateSkillId = config.orbit?.templateSkillId || DEFAULT_ORBIT.templateSkillId || '';
  if (!effectiveTemplateSkillId) return config;
  return {
    ...config,
    orbit: {
      ...(config.orbit ?? DEFAULT_ORBIT),
      templateSkillId: effectiveTemplateSkillId,
    },
  };
}

export function isOrbitRunDisabled(isBusy: boolean, connectedCount: number | null): boolean {
  return isBusy || connectedCount === null || connectedCount === 0;
}

function formatRelative(
  iso: string | undefined | null,
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string,
): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const absMin = Math.round(Math.abs(diffMs) / 60_000);
  if (absMin < 1) return t('common.justNow');
  if (absMin < 60) return t('common.minutesAgo', { n: absMin });
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) return t('common.hoursAgo', { n: absHr });
  const absDay = Math.round(absHr / 24);
  return t('common.daysAgo', { n: absDay });
}

function OrbitSection({
  cfg,
  setCfg,
  onOpenConnectors,
  onLeaveForOrbitProject,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  /** Open the Connectors catalog (Integrations page). Used by the Orbit
   *  gate's primary CTA so the user can wire up an integration. */
  onOpenConnectors: () => void;
  /** Called right before navigating to the generated Orbit project so the
   *  parent dialog can persist any unsaved Orbit edits and close itself. */
  onLeaveForOrbitProject: (runConfig: AppConfig) => void;
}) {
  const { locale, t } = useI18n();
  const orbit = cfg.orbit ?? DEFAULT_ORBIT;
  const [status, setStatus] = useState<OrbitStatusResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [legacyLastRunTemplateSkillId, setLegacyLastRunTemplateSkillId] = useState<string | null>(null);
  const legacyLastRunIdentity = status?.lastRun?.id
    ?? `${status?.lastRun?.completedAt ?? ''}:${status?.lastRun?.agentRunId ?? ''}:${status?.lastRun?.markdown ?? ''}`;
  // Orbit templates ship under the renderable design-templates registry after
  // the skills/design-templates split. We fetch on mount and keep three states
  // for graceful UX: `null` = still loading, `[]` = loaded with no Orbit
  // templates available, `SkillSummary[]` = ready. If the daemon is offline
  // the call resolves with [] (see fetchDesignTemplates) so the section never
  // throws — the rest of the Orbit controls keep working.
  const [orbitTemplates, setOrbitTemplates] = useState<SkillSummary[] | null>(null);
  // Connector presence drives the configuration gate at the top of the Orbit
  // tab. We track three states: `null` = still loading (skip rendering the
  // gate so it doesn't flash before data arrives), `0` = no connectors
  // present (gate is shown), `>0` = at least one connected integration
  // (gate is hidden). We only count connectors with `status === 'connected'`
  // because the catalog itself ships hundreds of available rows — what
  // matters for Orbit is whether anything has actually been wired up.
  const [connectedCount, setConnectedCount] = useState<number | null>(null);
  // Once the user clicks Generate we close Settings and navigate away. The ref
  // lets late-arriving handlers no-op without React warnings.
  const isMountedRef = useRef(true);
  useEffect(() => {
    // React Strict Mode replays mount effects in development. Reset the ref on
    // each setup so the synthetic cleanup from the first pass does not leave
    // async Orbit status / connector refreshes permanently thinking the panel
    // has unmounted.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const updateOrbit = (patch: Partial<NonNullable<AppConfig['orbit']>>) => {
    setCfg((curr) => ({
      ...curr,
      orbit: { ...(curr.orbit ?? DEFAULT_ORBIT), ...patch },
    }));
  };

  const refreshStatus = async () => {
    try {
      const response = await fetch('/api/orbit/status');
      if (!response.ok) return;
      if (!isMountedRef.current) return;
      setStatus(await response.json() as OrbitStatusResponse);
    } catch {
      // Daemon may be offline in API-only development; keep local controls usable.
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (!status?.running) return undefined;
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [status?.running]);

  // Fetch the design-template registry once on mount and filter to
  // scenario === 'orbit'. We tolerate fetch failure:
  // fetchDesignTemplates already swallows errors and returns []. The
  // component then transitions from "loading" → "empty" and the rest of the
  // Orbit panel stays fully functional.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const all = await fetchDesignTemplates();
      if (!alive) return;
      const filtered = all.filter((s) => s.scenario === 'orbit');
      // Stable order: featured first (higher number = more featured), then by name.
      filtered.sort((a, b) => {
        const af = a.featured ?? 0;
        const bf = b.featured ?? 0;
        if (af !== bf) return bf - af;
        return a.name.localeCompare(b.name);
      });
      setOrbitTemplates(filtered);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshConnectedCount = useCallback(async () => {
    const list = await fetchConnectors();
    if (!isMountedRef.current) return;
    const connected = list.filter((c) => c.status === 'connected').length;
    setConnectedCount(connected);
  }, []);

  // Fetch the connector catalog on mount to determine whether the Orbit
  // configuration gate should render. fetchConnectors swallows errors and
  // returns []; if the daemon is offline we treat that as "0 connected" and
  // surface the gate so the user has a clear path forward instead of being
  // dropped into a broken Orbit configuration.
  useEffect(() => {
    void refreshConnectedCount();
  }, [refreshConnectedCount]);

  // Connector auth often completes in another window. Re-check when focus
  // returns so the Orbit gate reflects newly connected accounts without
  // requiring the user to close and reopen Settings.
  useEffect(() => {
    const onFocus = () => {
      void refreshConnectedCount();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshConnectedCount]);

  // The id used to drive the prompt template — coalesces a null/empty
  // saved value to the built-in default (DEFAULT_ORBIT.templateSkillId,
  // currently 'orbit-general'). The select no longer offers a "no template"
  // option, so legacy configs that stored null are presented as if they
  // were on the default. Manual runs persist this effective value before
  // launching so the daemon uses the same template the UI displays.
  const effectiveTemplateSkillId = orbit.templateSkillId || DEFAULT_ORBIT.templateSkillId || '';
  const supportsTemplateScopedHistory = status?.lastRunsByTemplate !== undefined;

  useEffect(() => {
    const hasTemplateScopedHistory = Object.keys(status?.lastRunsByTemplate ?? {}).length > 0;
    const hasLegacyUnscopedLastRun = Boolean(status?.lastRun && !status.lastRun.templateSkillId);
    if (!hasLegacyUnscopedLastRun || hasTemplateScopedHistory) {
      setLegacyLastRunTemplateSkillId(null);
      return;
    }
    setLegacyLastRunTemplateSkillId((current) => current ?? (effectiveTemplateSkillId || null));
  }, [effectiveTemplateSkillId, legacyLastRunIdentity, status]);

  const selectedTemplate = useMemo(() => {
    if (!effectiveTemplateSkillId || !orbitTemplates) return null;
    return orbitTemplates.find((s) => s.id === effectiveTemplateSkillId) ?? null;
  }, [effectiveTemplateSkillId, orbitTemplates]);

  const triggerNow = () => {
    if (running) return;
    setRunning(true);
    setNotice(null);

    void (async () => {
      try {
        const runConfig = configForManualOrbitRun(cfg);
        const payload = await persistConfigAndRunOrbit(runConfig, { locale });
        if (!payload.projectId) throw new Error('Orbit run did not return a project');

        onLeaveForOrbitProject(runConfig);
        navigateRoute({
          kind: 'project',
          projectId: payload.projectId,
          conversationId: null,
          fileName: null,
        });
      } catch {
        if (!isMountedRef.current) return;
        setNotice({
          kind: 'error',
          message: t('settings.orbit.runError'),
        });
      } finally {
        if (!isMountedRef.current) return;
        setRunning(false);
        void refreshStatus();
      }
    })();
  };

  const templateScopedLastRun = effectiveTemplateSkillId
    ? status?.lastRunsByTemplate?.[effectiveTemplateSkillId] ?? null
    : null;
  const hasLegacyUnscopedLastRun = Boolean(
    status?.lastRun
    && !status.lastRun.templateSkillId
    && legacyLastRunTemplateSkillId
    && legacyLastRunTemplateSkillId === effectiveTemplateSkillId,
  );
  const lastRun = supportsTemplateScopedHistory
    ? (templateScopedLastRun ?? (hasLegacyUnscopedLastRun ? status?.lastRun ?? null : null))
    : status?.lastRun ?? null;
  const nextRunLabel = status?.nextRunAt ? new Date(status.nextRunAt).toLocaleString() : null;
  const lastRunAbs = lastRun ? new Date(lastRun.completedAt).toLocaleString() : null;
  const lastRunRel = formatRelative(lastRun?.completedAt, t);
  const liveArtifactHref = lastRun?.artifactId && lastRun?.artifactProjectId
    ? `/api/live-artifacts/${encodeURIComponent(lastRun.artifactId)}/preview?projectId=${encodeURIComponent(lastRun.artifactProjectId)}`
    : null;
  const isBusy = running || Boolean(status?.running);

  const copyMarkdown = async () => {
    if (!lastRun?.markdown) return;
    try {
      await navigator.clipboard.writeText(lastRun.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access may be denied in some browsing contexts; silently skip.
    }
  };

  // Proportional widths for the run-result meter. We avoid showing 0-width
  // segments by falling back to a tiny sliver when a category has hits but
  // rounds to 0% — the visual "something happened here" cue matters more
  // than exact proportion at low counts.
  const total = lastRun
    ? Math.max(
        lastRun.connectorsSucceeded + lastRun.connectorsSkipped + lastRun.connectorsFailed,
        1,
      )
    : 1;
  const segPct = (n: number) => {
    if (!lastRun || n <= 0) return 0;
    const pct = (n / total) * 100;
    return pct < 3 ? 3 : pct;
  };
  const meterSucceeded = lastRun ? segPct(lastRun.connectorsSucceeded) : 0;
  const meterSkipped = lastRun ? segPct(lastRun.connectorsSkipped) : 0;
  const meterFailed = lastRun ? segPct(lastRun.connectorsFailed) : 0;

  const automationState = orbit.enabled ? 'active' : 'off';
  const triggerLabel = lastRun?.trigger === 'manual'
    ? t('settings.orbit.triggerManual')
    : t('settings.orbit.triggerScheduled');

  // Surface the configuration gate when we know for sure that the user has
  // no connected integrations. While `connectedCount === null` we are still
  // loading and intentionally hide the gate so the panel doesn't flash an
  // empty-state warning before data arrives. Once resolved, `0` triggers
  // the gate, whose CTA pushes the user toward picking an integration.
  const showConfigGate = connectedCount === 0;
  // Disable the hero's "Run it now" CTA while the gate is visible: running
  // without any connector wired up surfaces a cryptic backend error. We
  // keep the button mounted so layout stays stable; a tooltip and the
  // adjacent gate make the disabled reason obvious.
  const runDisabled = isOrbitRunDisabled(isBusy, connectedCount);
  const runDisabledTitle = showConfigGate
    ? t('settings.orbit.gateTitle')
    : t('settings.orbit.runTitle');

  // When the configuration gate is visible (no connector available) we
  // also lock down every secondary control on the panel — schedule
  // toggle, time input, prompt template select, and the missing-template
  // Reset button. Touching any of them before a connector exists either
  // produces a no-op or persists state the user can't actually exercise.
  // Locking them keeps the panel honest, prevents "ghost configuration",
  // and reinforces the gate's CTA as the only meaningful next step.
  const controlsLocked = showConfigGate;
  const controlsLockedHint = controlsLocked
    ? t('settings.orbit.controlsLockedHint')
    : undefined;

  return (
    <section className="settings-section orbit-section">
      {/* ---------- 1. HEADER ZONE ---------- */}
      <header className="orbit-hero">
        <div className="orbit-hero-mark" aria-hidden="true">
          <Icon name="refresh" size={20} />
        </div>
        <div className="orbit-hero-copy">
          <span className="orbit-hero-eyebrow">{t('settings.orbit.eyebrow')}</span>
          <h3 className="orbit-hero-title">{t('settings.orbit.title')}</h3>
          <p className="orbit-hero-lede">
            {t('settings.orbit.lede')}
          </p>
        </div>
        <div className="orbit-hero-actions">
          <span
            className={`orbit-state-pill orbit-state-${automationState}`}
            title={
              orbit.enabled
                ? t('settings.orbit.statusOnTitle')
                : t('settings.orbit.statusOffTitle')
            }
          >
            <span className="orbit-state-dot" aria-hidden="true" />
            {orbit.enabled
              ? t('settings.orbit.statusActive')
              : t('settings.orbit.statusOff')}
          </span>
          <button
            type="button"
            className={'orbit-run-cta' + (isBusy ? ' is-busy' : '')}
            onClick={() => void triggerNow()}
            disabled={runDisabled}
            title={runDisabledTitle}
          >
            {isBusy ? (
              <>
                <Icon name="spinner" size={14} className="icon-spin" />
                <span>{t('settings.orbit.running')}</span>
              </>
            ) : (
              <>
                <Icon name="play" size={14} />
                <span>{t('settings.orbit.runOpen')}</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* ---------- 1b. CONFIGURATION GATE ----------
          Renders when no connected integrations are present. Orbit's job is
          to summarize connector activity, so without any wired-up
          connector there is literally nothing for it to report on.
          The gate uses the same orbit-themed accent surface as the
          automation card to feel like a first-class part of the panel
          rather than an inline error, and routes the user to the
          Connectors catalog on the Integrations page. */}
      {showConfigGate ? (
        <div
          className="orbit-config-gate"
          role="region"
          aria-label={t('settings.orbit.gateAriaLabel')}
          data-testid="orbit-config-gate"
        >
          <div className="orbit-config-gate-glyph" aria-hidden="true">
            <span className="orbit-config-gate-ring orbit-config-gate-ring-outer" />
            <span className="orbit-config-gate-ring orbit-config-gate-ring-inner" />
            <span className="orbit-config-gate-icon">
              <Icon name="link" size={16} />
            </span>
          </div>
          <div className="orbit-config-gate-copy">
            <span className="orbit-config-gate-eyebrow">
              {t('settings.orbit.gateEyebrow')}
            </span>
            <h4 className="orbit-config-gate-title">
              {t('settings.orbit.gateTitle')}
            </h4>
            <p className="orbit-config-gate-body">
              {t('settings.orbit.gateBody')}
            </p>
          </div>
          <div className="orbit-config-gate-actions">
            <button
              type="button"
              className="orbit-config-gate-action"
              onClick={onOpenConnectors}
              data-testid="orbit-config-gate-action"
            >
              <span>{t('settings.orbit.gateAction')}</span>
              <Icon name="chevron-right" size={13} />
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------- 2. AUTOMATION CARD ----------
          Single unified configuration surface for Orbit: the daily-summary
          switch, the run-time schedule, and the prompt-template selection
          all live inside one card, separated by hairline dividers. The
          template row was previously a parallel card; folding it in here
          collapses the "two paired panels" pattern into one cohesive
          stack so users configure Orbit in one place. */}
      <div
        className={`orbit-automation${orbit.enabled ? ' is-on' : ''}${selectedTemplate ? ' has-template' : ''}${controlsLocked ? ' is-locked' : ''}`}
        aria-busy={orbitTemplates === null || undefined}
        aria-disabled={controlsLocked || undefined}
        data-testid="orbit-automation-card"
      >
        {controlsLocked ? (
          <div
            className="orbit-automation-lock-banner"
            role="note"
            aria-label={t('settings.orbit.controlsLockedHint')}
          >
            <Icon name="link" size={12} />
            <span className="orbit-automation-lock-badge">
              {t('settings.orbit.controlsLockedBadge')}
            </span>
            <span className="orbit-automation-lock-text">
              {t('settings.orbit.controlsLockedHint')}
            </span>
          </div>
        ) : null}
        <div className="orbit-automation-row orbit-automation-switch-row">
          <div className="orbit-automation-label">
            <span className="orbit-automation-title">{t('settings.orbit.dailySummaryTitle')}</span>
            <span className="orbit-automation-sub">
              {t('settings.orbit.dailySummarySub')}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={orbit.enabled}
            aria-disabled={controlsLocked || undefined}
            className={`orbit-switch${orbit.enabled ? ' is-on' : ''}${controlsLocked ? ' is-locked' : ''}`}
            disabled={controlsLocked}
            title={controlsLockedHint}
            onClick={() => updateOrbit({ enabled: !orbit.enabled })}
          >
            <span className="orbit-switch-track" aria-hidden="true">
              <span className="orbit-switch-thumb" />
            </span>
            <span className="orbit-switch-text">
              {orbit.enabled ? t('settings.orbit.on') : t('settings.orbit.off')}
            </span>
          </button>
        </div>

        <div className="orbit-automation-divider" aria-hidden="true" />

        <div className="orbit-automation-row orbit-automation-schedule-row">
          <div className="orbit-automation-label">
            <span className="orbit-automation-title">{t('settings.orbit.runTimeTitle')}</span>
            <span className="orbit-automation-sub">
              {t('settings.orbit.runTimeSub')}
            </span>
          </div>
          <div className="orbit-automation-schedule-controls">
            <input
              type="time"
              className="orbit-time-input"
              value={orbit.time}
              onChange={(e) => updateOrbit({ time: e.target.value || DEFAULT_ORBIT.time })}
              aria-label={t('settings.orbit.runTimeAria')}
              aria-disabled={controlsLocked || undefined}
              disabled={controlsLocked}
              title={controlsLockedHint}
            />
            <div className="orbit-next-run" aria-live="polite">
              {orbit.enabled ? (
                nextRunLabel ? (
                  <>
                    <span className="orbit-next-run-label">{t('settings.orbit.nextRun')}</span>
                    <span className="orbit-next-run-value">{nextRunLabel}</span>
                  </>
                ) : (
                  <>
                    <span className="orbit-next-run-label">{t('settings.orbit.nextRun')}</span>
                    <span className="orbit-next-run-value muted">{t('settings.orbit.nextRunScheduledAfterSave')}</span>
                  </>
                )
              ) : (
                <>
                  <span className="orbit-next-run-label">{t('settings.orbit.schedule')}</span>
                  <span className="orbit-next-run-value muted">{t('settings.orbit.pausedManualOnly')}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="orbit-automation-divider" aria-hidden="true" />

        {/* Prompt template row — folded into the automation card so users
            configure schedule and prompt steering in one place. The select
            picks which scenario === 'orbit' skill template gets injected
            into the Orbit prompt. There is no separate preview slab below
            the select: the dropdown's option label is the source of
            truth for the active template, and each option carries the
            skill description as a `title` tooltip. The only state that
            still needs explicit surfacing is "saved id no longer in the
            registry" — that warning replaces the row's normal sub-copy
            and inlines a Reset action when the missing id differs from
            the default. */}
        <div className="orbit-automation-row orbit-automation-template-row">
          <div className="orbit-automation-label">
            {/* Title aligns with the other automation rows ("Daily summary",
                "Run time") — a single short label. */}
            <span className="orbit-automation-title">{t('settings.orbit.templateTitle')}</span>
            {orbitTemplates &&
            effectiveTemplateSkillId &&
            !orbitTemplates.some((s) => s.id === effectiveTemplateSkillId) ? (
              // The saved skill id is no longer installed — surface a
              // soft warning right under the title, with an inline Reset
              // action that pushes back to DEFAULT_ORBIT (currently
              // `orbit-general`). Reset is hidden when the missing id
              // already equals the default, so the control never loops
              // on itself.
              <span
                className="orbit-automation-sub orbit-automation-sub-warning"
                role="status"
              >
                <Icon name="history" size={11} />
                <span>
                  {t('settings.orbit.templateMissing', { id: effectiveTemplateSkillId })}{' '}
                  {orbitTemplates.length === 0
                    ? t('settings.orbit.templateMissingInstall')
                    : t('settings.orbit.templateMissingPickAnother')}
                </span>
                {DEFAULT_ORBIT.templateSkillId &&
                effectiveTemplateSkillId !== DEFAULT_ORBIT.templateSkillId ? (
                  <button
                    type="button"
                    className="orbit-automation-sub-action"
                    disabled={controlsLocked}
                    aria-disabled={controlsLocked || undefined}
                    onClick={() =>
                      updateOrbit({ templateSkillId: DEFAULT_ORBIT.templateSkillId })
                    }
                    title={
                      controlsLocked
                        ? t('settings.orbit.controlsLockedHint')
                        : t('settings.orbit.templateResetTitle', {
                            id: DEFAULT_ORBIT.templateSkillId,
                          })
                    }
                  >
                    {t('settings.orbit.templateReset')}
                  </button>
                ) : null}
              </span>
            ) : (
              <span className="orbit-automation-sub">
                {t('settings.orbit.templateHelp')}
              </span>
            )}
          </div>
          <div className="orbit-automation-template-controls">
            <div className="orbit-template-select">
              <div className="orbit-template-select-wrap">
                <select
                  id="orbit-template-select"
                  className="orbit-template-select-input"
                  aria-label={t('settings.orbit.templateAria')}
                  aria-disabled={controlsLocked || undefined}
                  value={effectiveTemplateSkillId}
                  disabled={orbitTemplates === null || controlsLocked}
                  title={controlsLockedHint}
                  onChange={(e) => {
                    const next = e.target.value;
                    // Guard against the loading placeholder making it
                    // through onChange — only persist real skill ids.
                    if (!next) return;
                    updateOrbit({ templateSkillId: next });
                  }}
                >
                  {/* While the skill registry is still loading we render a
                      single non-interactive placeholder so the select has
                      a value to display. Once `orbitTemplates` resolves we
                      drop the placeholder entirely — the dropdown lists
                      only real Orbit skill templates, so there is no
                      "no template" / "use built-in" option to pick. */}
                  {orbitTemplates === null ? (
                    <option value="">{t('settings.orbit.templatesLoading')}</option>
                  ) : null}
                  {/* If the saved id no longer exists in the registry,
                      surface it as a hidden placeholder so the controlled
                      <select> doesn't fall back to the first real option
                      and silently mutate the user's stored choice. The
                      inline warning above offers the explicit Reset
                      action. */}
                  {orbitTemplates &&
                  effectiveTemplateSkillId &&
                  !orbitTemplates.some((s) => s.id === effectiveTemplateSkillId) ? (
                    <option value={effectiveTemplateSkillId} hidden>
                      {t('settings.orbit.templateMissingOption', {
                        id: effectiveTemplateSkillId,
                      })}
                    </option>
                  ) : null}
                  {orbitTemplates && orbitTemplates.length > 0 ? (
                    <optgroup label={t('settings.orbit.templatesOptgroup')}>
                      {orbitTemplates.map((s) => (
                        <option
                          key={s.id}
                          value={s.id}
                          // Browser-native tooltip — surfaces the skill
                          // description on hover without needing a
                          // dedicated preview panel.
                          title={s.description ?? undefined}
                        >
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
                <Icon
                  name="chevron-down"
                  size={12}
                  className="orbit-template-select-chevron"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---------- 4. RUN RESULT / RECEIPT ---------- */}
      {/* When there is no last run yet, the "receipt" metaphor doesn't fit —
          there's nothing to report. We swap to a first-run prompt with its
          own composed layout (orbit-glyph · copy · inline CTA) so the empty
          state feels intentional and rhythmically balanced with the hero,
          automation card, and (eventual) artifact strip. */}
      {lastRun ? (
        <div className="orbit-receipt">
          <div className="orbit-receipt-head">
            <div className="orbit-receipt-head-left">
              <span className="orbit-receipt-eyebrow">
                <Icon name="history" size={12} />
                {t('settings.orbit.lastRun')}
              </span>
              <span
                className="orbit-receipt-timestamp"
                title={lastRunAbs ?? undefined}
              >
                {lastRunRel ?? lastRunAbs}
              </span>
            </div>
            <span
              className={`orbit-trigger-pill orbit-trigger-${lastRun.trigger ?? 'scheduled'}`}
            >
              {triggerLabel}
            </span>
          </div>

          {notice ? (
            <div
              className={`orbit-inline-notice is-${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              <Icon name={notice.kind === 'error' ? 'close' : 'check'} size={12} />
              <span>{notice.message}</span>
            </div>
          ) : null}

          <div
            className="orbit-meter"
            role="img"
            aria-label={t('settings.orbit.meterAria', {
              succeeded: lastRun.connectorsSucceeded,
              skipped: lastRun.connectorsSkipped,
              failed: lastRun.connectorsFailed,
              checked: lastRun.connectorsChecked,
            })}
          >
            {meterSucceeded > 0 ? (
              <span
                className="orbit-meter-seg is-succeeded"
                style={{ width: `${meterSucceeded}%` }}
              />
            ) : null}
            {meterSkipped > 0 ? (
              <span
                className="orbit-meter-seg is-skipped"
                style={{ width: `${meterSkipped}%` }}
              />
            ) : null}
            {meterFailed > 0 ? (
              <span
                className="orbit-meter-seg is-failed"
                style={{ width: `${meterFailed}%` }}
              />
            ) : null}
            {meterSucceeded + meterSkipped + meterFailed === 0 ? (
              <span className="orbit-meter-seg is-empty" />
            ) : null}
          </div>
          <dl className="orbit-counts">
            <div className="orbit-count">
              <dt>{t('settings.orbit.countChecked')}</dt>
              <dd>{lastRun.connectorsChecked}</dd>
            </div>
            <div className="orbit-count is-succeeded">
              <dt>{t('settings.orbit.countSucceeded')}</dt>
              <dd>{lastRun.connectorsSucceeded}</dd>
            </div>
            <div className="orbit-count is-skipped">
              <dt>{t('settings.orbit.countSkipped')}</dt>
              <dd>{lastRun.connectorsSkipped}</dd>
            </div>
            <div className="orbit-count is-failed">
              <dt>{t('settings.orbit.countFailed')}</dt>
              <dd>{lastRun.connectorsFailed}</dd>
            </div>
          </dl>
        </div>
      ) : notice ? (
        <div
          className={`orbit-inline-notice is-${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          <Icon name={notice.kind === 'error' ? 'close' : 'check'} size={12} />
          <span>{notice.message}</span>
        </div>
      ) : null}

      {/* ---------- 5. LIVE ARTIFACT STRIP ---------- */}
      {lastRun ? (
        <div
          className={`orbit-artifact-strip${liveArtifactHref ? '' : ' is-legacy'}`}
        >
          <div className="orbit-artifact-strip-icon" aria-hidden="true">
            <Icon name="file-code" size={18} />
          </div>
          <div className="orbit-artifact-strip-copy">
            <span className="orbit-artifact-strip-kicker">
              {liveArtifactHref
                ? t('settings.orbit.artifactKickerLive')
                : t('settings.orbit.artifactKickerLegacy')}
            </span>
            <span className="orbit-artifact-strip-title">
              {t('settings.orbit.artifactTitle')}
            </span>
            <span className="orbit-artifact-strip-meta">
              {liveArtifactHref
                ? t('settings.orbit.artifactMetaLive')
                : t('settings.orbit.artifactMetaLegacy')}
            </span>
          </div>
          <div className="orbit-artifact-strip-actions">
            {lastRun.markdown ? (
              <button
                type="button"
                className="orbit-artifact-ghost"
                onClick={() => void copyMarkdown()}
                title={t('settings.orbit.copyMarkdownTitle')}
              >
                {copied ? (
                  <>
                    <Icon name="check" size={13} />
                    <span>{t('settings.orbit.copied')}</span>
                  </>
                ) : (
                  <>
                    <Icon name="copy" size={13} />
                    <span>{t('settings.orbit.copy')}</span>
                  </>
                )}
              </button>
            ) : null}
            {liveArtifactHref ? (
              <a
                className="orbit-artifact-open"
                href={liveArtifactHref}
                target="_blank"
                rel="noreferrer"
              >
                <span>{t('settings.orbit.openArtifact')}</span>
                <Icon name="external-link" size={13} />
              </a>
            ) : null}
          </div>
          {lastRun.markdown ? (
            <details className="orbit-artifact-peek">
              <summary>
                <Icon name="chevron-right" size={12} />
                <span>{t('settings.orbit.sourceMarkdown')}</span>
              </summary>
              <pre>{lastRun.markdown}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}


// Per-client install paths. Each entry's `snippet` is what the user
// copies; some clients also support a richer `deeplink` flow that
// triggers a one-click install with an in-client approval dialog.
//
// Schemas drift between clients in deliberate ways. VS Code keys
// servers under "servers" with a required "type" field; Zed uses
// "context_servers"; Cursor, Windsurf, and Antigravity share
// "mcpServers"; Claude Code is best served by its CLI which writes
// to the local config for you. Verified against each tool's official
// docs in May 2026.
//
// Important: every snippet uses absolute paths to the daemon's current
// Node-compatible runtime and built cli.js, fetched at runtime. macOS
// and Linux ship a system /usr/bin/od (octal-dump) that shadows any
// `od` we might add to PATH, and most Open Design users run from
// source where `od` is not installed globally. The installer panel
// must NOT reference bare `od`.
type McpClientId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'vscode'
  | 'zed'
  | 'windsurf'
  | 'antigravity';

interface McpInstallInfo {
  command: string;
  args: string[];
  env?: Record<string, string>;
  daemonUrl: string;
  platform: 'darwin' | 'linux' | 'win32' | string;
  cliExists: boolean;
  nodeExists: boolean;
  buildHint: string | null;
}

interface McpStdioServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpClient {
  id: McpClientId;
  label: string;
  // Function so the dropdown can show different methods per OS
  // (Claude Code uses CLI on POSIX but JSON edit on Windows because
  // the bash/PowerShell/cmd.exe quoting is too fragile to reliably
  // emit a single command that works in every shell).
  buildMethod: (info: McpInstallInfo) => string;
  // Function so per-OS path hints (~/.cursor on POSIX vs
  // %USERPROFILE%\.cursor on Windows) and shortcut differences
  // (⌘⇧P vs Ctrl+Shift+P) can be rendered correctly.
  buildInstruction: (info: McpInstallInfo) => string;
  buildSnippet: (info: McpInstallInfo) => string;
  buildSnippetLang: (info: McpInstallInfo) => 'bash' | 'json' | 'toml';
  // Optional one-click install action. Currently only Cursor
  // supports deeplinks of this shape.
  buildDeeplink?: (info: McpInstallInfo) => string;
  deeplinkLabel?: () => string;
}

// Path hint per OS. Localizes the "where to paste" copy so a
// Windows user does not see ~/.cursor/mcp.json (which their shell
// will not expand) or a Linux user does not see %APPDATA% paths.
function homeConfigPath(
  platform: McpInstallInfo['platform'],
  posix: string,
  windows: string,
): string {
  return platform === 'win32' ? windows : posix;
}

function commandPaletteShortcut(platform: McpInstallInfo['platform']): string {
  return platform === 'darwin' ? '⌘⇧P' : 'Ctrl+Shift+P';
}

function settingsShortcut(platform: McpInstallInfo['platform']): string {
  return platform === 'darwin' ? '⌘,' : 'Ctrl+,';
}

// btoa() requires every input character be representable in Latin-1
// (codepoints 0-255). A Mac/Linux home directory like
// "/Users/Émile/.fnm/.../node" trips that and throws
// InvalidCharacterError. UTF-8-encode the string into bytes first,
// then map each byte back to a Latin-1 char before base64'ing.
function utf8Btoa(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function buildMcpStdioServerConfig(info: McpInstallInfo): McpStdioServerConfig {
  const env = info.env && Object.keys(info.env).length > 0 ? info.env : undefined;
  return {
    command: info.command,
    args: info.args,
    ...(env ? { env } : {}),
  };
}

function buildCodexEnvToml(info: McpInstallInfo): string {
  const entries = Object.entries(info.env ?? {});
  if (entries.length === 0) return '';
  return `

[mcp_servers.open-design.env]
${entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}`;
}

function buildSharedMcpJson(info: McpInstallInfo): string {
  const inner = buildMcpStdioServerConfig(info);
  const innerJson = JSON.stringify(inner, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `    ${line}`))
    .join('\n');
  return `{
  "mcpServers": {
    "open-design": ${innerJson}
  }
}`;
}

// One-click install toggle for Codex: queries the daemon for whether
// `codex mcp get open-design` succeeds, and POSTs/DELETEs the install
// endpoint to call `codex mcp add/remove` on the user's behalf. The
// copy-snippet path still works for users who prefer to paste manually
// or whose Codex CLI is not on PATH (button shows a disabled hint in
// that case).
function CodexInstallToggle(): JSX.Element | null {
  const { t } = useI18n();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/install/codex/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { available: boolean; installed: boolean };
      setAvailable(Boolean(data.available));
      setInstalled(Boolean(data.installed));
    } catch {
      // Daemon unreachable or endpoint missing — hide the toggle
      // entirely rather than spook the user with a permanent error.
      setAvailable(false);
      setInstalled(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (method: 'POST' | 'DELETE', successKey: 'settings.mcpCodexInstallSuccess' | 'settings.mcpCodexUninstallSuccess') => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch('/api/mcp/install/codex', { method });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(body?.error?.message || `HTTP ${res.status}`);
        }
        setMessage({ kind: 'success', text: t(successKey) });
        await refresh();
      } catch (err) {
        setMessage({
          kind: 'error',
          text: t('settings.mcpCodexInstallError', { error: err instanceof Error ? err.message : String(err) }),
        });
      } finally {
        setBusy(false);
      }
    },
    [refresh, t],
  );

  if (available === null) return null;

  if (!available) {
    return (
      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          disabled
          style={{ padding: '6px 14px', fontSize: 13, opacity: 0.6 }}
        >
          {t('settings.mcpCodexOneClickInstall')}
        </button>
        <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--fg-2, #9aa0a6)' }}>
          {t('settings.mcpCodexOneClickUnavailable')}
        </span>
      </div>
    );
  }

  const label = installed
    ? t('settings.mcpCodexOneClickUninstall')
    : t('settings.mcpCodexOneClickInstall');
  const onClick = () => {
    if (installed) {
      void run('DELETE', 'settings.mcpCodexUninstallSuccess');
    } else {
      void run('POST', 'settings.mcpCodexInstallSuccess');
    }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        className={installed ? '' : 'primary'}
        disabled={busy}
        onClick={onClick}
        style={{ padding: '6px 14px', fontSize: 13 }}
      >
        {busy ? t('settings.mcpCodexBusy') : label}
      </button>
      {message ? (
        <span
          style={{
            marginLeft: 10,
            fontSize: 12,
            color: message.kind === 'error' ? 'var(--danger, #ff6b6b)' : 'var(--fg-2, #9aa0a6)',
          }}
        >
          {message.text}
        </span>
      ) : null}
    </div>
  );
}

function IntegrationsSection() {
  const { t } = useI18n();

  const MCP_CLIENTS: McpClient[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      buildMethod: () => t('settings.mcpMethodCli'),
      buildInstruction: () => t('settings.mcpInstructionCli'),
      buildSnippet: (info) => {
        const inner = JSON.stringify(buildMcpStdioServerConfig(info));
        return `claude mcp add-json --scope user open-design '${inner}'`;
      },
      buildSnippetLang: () => 'bash',
    },
    {
      id: 'codex',
      label: 'Codex',
      buildMethod: () => t('settings.mcpMethodToml'),
      buildInstruction: (info) => {
        const path = homeConfigPath(
          info.platform,
          '~/.codex/config.toml',
          '%USERPROFILE%\\.codex\\config.toml',
        );
        return t('settings.mcpInstructionCodex', { path });
      },
      buildSnippet: (info) => `[mcp_servers.open-design]\ncommand = ${JSON.stringify(info.command)}\nargs = ${JSON.stringify(info.args)}${buildCodexEnvToml(info)}`,
      buildSnippetLang: () => 'toml',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      buildMethod: () => t('settings.mcpMethodOneClick'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionCursor', {
          path: homeConfigPath(info.platform, '~/.cursor/mcp.json', '%USERPROFILE%\\.cursor\\mcp.json'),
        }),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
      buildDeeplink: (info) => {
        const inner = buildMcpStdioServerConfig(info);
        const encoded = utf8Btoa(JSON.stringify(inner));
        return `cursor://anysphere.cursor-deeplink/mcp/install?name=open-design&config=${encoded}`;
      },
      deeplinkLabel: () => t('settings.mcpDeeplinkInstallCursor'),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionCopilot', {
          shortcut: commandPaletteShortcut(info.platform),
        }),
      buildSnippet: (info) => `{\n  "servers": {\n    "open-design": {\n      "type": "stdio",\n      "command": ${JSON.stringify(info.command)},\n      "args": ${JSON.stringify(info.args)}${info.env && Object.keys(info.env).length > 0 ? `,\n      "env": ${JSON.stringify(info.env)}` : ''}\n    }\n  }\n}`,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: () => t('settings.mcpInstructionAntigravity'),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'zed',
      label: 'Zed',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionZed', {
          shortcut: settingsShortcut(info.platform),
        }),
      buildSnippet: (info) => `{\n  "context_servers": {\n    "open-design": {\n      "source": "custom",\n      "command": ${JSON.stringify(info.command)},\n      "args": ${JSON.stringify(info.args)}${info.env && Object.keys(info.env).length > 0 ? `,\n      "env": ${JSON.stringify(info.env)}` : ''}\n    }\n  }\n}`,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionWindsurf', {
          path: homeConfigPath(info.platform, '~/.codeium/windsurf/mcp_config.json', '%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json'),
        }),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
    },
  ];

  const [clientId, setClientId] = useState<McpClientId>('claude');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [info, setInfo] = useState<McpInstallInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // The reset is wired through a ref-driven timer rather than effect
  // cleanup so re-clicks during the 2s window restart the countdown.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Close the dropdown on outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // Pull the absolute paths to node + cli.js from the running daemon
  // so snippets work even when `od` isn't on PATH (the realistic
  // case for source clones, plus macOS/Linux ship a /usr/bin/od that
  // shadows any global install). Fetched on mount; if the daemon is
  // unreachable we surface a clear error instead of a half-built
  // snippet that would silently fail when pasted.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/mcp/install-info')
      .then(async (res) => {
        if (!res.ok) throw new Error(`daemon ${res.status}`);
        return (await res.json()) as McpInstallInfo;
      })
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setInfoError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setInfoError(String(err && err.message ? err.message : err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const client = MCP_CLIENTS.find((c) => c.id === clientId) ?? MCP_CLIENTS[0]!;
  const snippet = info ? client.buildSnippet(info) : '';
  const snippetLang: 'bash' | 'json' | 'toml' = info
    ? client.buildSnippetLang(info)
    : 'json';

  // Reset the "Copied" badge when the user flips to a different
  // client; otherwise the green check sits there next to a snippet
  // they haven't actually copied.
  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [clientId]);

  const onCopy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail under non-secure contexts; the snippet
      // is selectable so the user can still copy manually.
      setCopied(false);
    }
  };

  return (
    <section className="settings-section">
      <div className="mcp-client-body">
        {infoError ? (
          <div
            className="empty-card"
            style={{ marginBottom: 14, color: 'var(--danger-fg, #f88)' }}
          >
            {t('settings.mcpDaemonError', { error: infoError! })}
          </div>
        ) : null}

        {/* Group 1: what the MCP server does */}
        <div className="mcp-capabilities-card">
          <p className="mcp-capabilities-label">
            {t('settings.mcpCapabilitiesTitle')}
          </p>
          <ul className="mcp-capabilities-list">
            <li>{t('settings.mcpCapabilityRead')}</li>
            <li>{t('settings.mcpCapabilityPull')}</li>
            <li>{t('settings.mcpCapabilityDefault')}</li>
          </ul>
        </div>

        {/* Group 2: setup flow */}
        <div className="mcp-setup-card">
          <div
            className="ds-picker"
            ref={pickerRef}
          >
          <button
            type="button"
            className={`ds-picker-trigger${pickerOpen ? ' open' : ''}`}
            onClick={() => setPickerOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
          >
            <span className="ds-picker-meta">
              <span className="ds-picker-title">{client.label}</span>
              <span className="ds-picker-sub">
                {info ? client.buildMethod(info) : ''}
              </span>
            </span>
            <Icon
              name="chevron-down"
              size={14}
              className="ds-picker-chevron"
              style={{ transform: pickerOpen ? 'rotate(180deg)' : undefined }}
            />
          </button>
          {pickerOpen ? (
            <div className="ds-picker-popover" role="listbox">
              <div className="ds-picker-list">
                {MCP_CLIENTS.map((c) => {
                  const active = c.id === clientId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`ds-picker-item${active ? ' active' : ''}`}
                      onClick={() => {
                        setClientId(c.id);
                        setPickerOpen(false);
                      }}
                    >
                      <span className="ds-picker-item-text">
                        <span className="ds-picker-item-title">{c.label}</span>
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--text-muted)',
                          }}
                        >
                          {info ? c.buildMethod(info) : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {info ? (
          <p style={{ margin: 0 }}>{client.buildInstruction(info)}</p>
        ) : null}

        {client.id === 'codex' ? <CodexInstallToggle /> : null}

        {client.buildDeeplink && info ? (
          <div style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="primary"
              onClick={() => {
                // Use a hidden anchor so the cursor:// scheme is
                // handled the same way as a normal link click; some
                // browsers block window.location assignments to
                // unknown schemes from button handlers.
                const url = client.buildDeeplink!(info);
                const a = document.createElement('a');
                a.href = url;
                a.rel = 'noopener noreferrer';
                a.click();
              }}
              disabled={!info.cliExists || !info.nodeExists}
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              <Icon name="link" size={14} />
              <span style={{ marginLeft: 6 }}>{client.deeplinkLabel ? client.deeplinkLabel() : ''}</span>
            </button>
            <span
              style={{
                marginLeft: 10,
                fontSize: 12,
                color: 'var(--fg-2, #9aa0a6)',
              }}
            >
              {t('settings.mcpCursorApproval')}
            </span>
          </div>
        ) : null}

        <div style={{ position: 'relative' }}>
          <pre
            style={{
              background: 'var(--surface-2, #11141a)',
              color: 'var(--fg-1, #e6e6e6)',
              // Reserve top clearance for the absolutely-positioned
              // Copy button so the first line of the snippet does not
              // sit underneath it, and reserve right clearance so a
              // wrapped bash one-liner stops short of the button rather
              // than scrolling behind it. The right padding is sized
              // for the wider "Copied" post-click state (icon + text +
              // button padding + the 8px right offset) with a few px
              // of buffer for elevated font sizes / zoom. Issue #632.
              padding: '40px 104px 12px 14px',
              borderRadius: 8,
              overflowX: 'auto',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.55,
              margin: 0,
              userSelect: 'text',
              whiteSpace: snippetLang === 'bash' ? 'pre-wrap' : 'pre',
              wordBreak: snippetLang === 'bash' ? 'break-all' : 'normal',
              minHeight: 60,
            }}
            data-lang={snippetLang}
          >
            <code
              style={{
                // Neutralize the global inline-`code` chip style (background,
                // padding, rounded corners, color, size) so it doesn't paint a
                // light rounded rectangle behind every wrapped segment of the
                // dark snippet block — which read as permanent selection
                // highlights on the wrapped `claude mcp add-json` one-liner.
                // Issue #4509.
                background: 'transparent',
                padding: 0,
                borderRadius: 0,
                color: 'inherit',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
            >
              {snippet ||
                (infoError
                  ? t('settings.mcpResolvingFailed')
                  : t('settings.mcpLoadingPaths'))}
            </code>
          </pre>
          <button
            type="button"
            className="ghost mcp-copy-btn"
            onClick={onCopy}
            disabled={!snippet}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              padding: '4px 10px',
              fontSize: 12,
            }}
            aria-label={t('settings.mcpCopyAria')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            <span style={{ marginLeft: 6 }}>{copied ? t('settings.mcpCopied') : t('settings.mcpCopy')}</span>
          </button>
        </div>

        {/* "Build the daemon first" lives here — next to the code
            block it explains — rather than at the top of the section
            before the user has seen anything. A dev-mode pre-condition
            warning at the very top reads as "something is broken"
            before the user has even picked their client. */}
        {info && (!info.cliExists || !info.nodeExists) ? (
          <div
            className="empty-card"
            style={{ borderLeft: '3px solid var(--warning-fg, #fbbf24)' }}
          >
            <strong>
              {!info.cliExists
                ? t('settings.mcpBuildDaemon')
                : t('settings.mcpNodeMissing')}
            </strong>{' '}
            {info.buildHint ?? t('settings.mcpBuildHint')}
          </div>
        ) : null}

        {/* Restart note is a "next step" after running the command,
            not an error — keep it right after the code block. */}
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
            borderLeft: '3px solid var(--border-strong)',
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong>{t('settings.mcpRestartNote')}</strong>{' '}
          <span style={{ color: 'var(--text-muted)' }}>
            {t('settings.mcpRestartDetail')}
          </span>
        </div>

          <p className="mcp-running-note">
            {t('settings.mcpRunningNote')}
          </p>
        </div>{/* end mcp-setup-card */}
      </div>
    </section>
  );
}

const THEMES: Array<{ value: AppTheme; labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark'; icon?: 'sun' | 'moon' }> = [
  { value: 'system', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight', icon: 'sun' },
  { value: 'dark', labelKey: 'settings.themeDark', icon: 'moon' },
];

function AppearanceSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const current = cfg.theme ?? 'system';
  const currentAccent = normalizeAccentColor(cfg.accentColor) ?? DEFAULT_ACCENT_COLOR;
  const accentLabel = t('pet.fieldAccent');
  const defaultAccentLabel = t('pet.fieldAccentDefault');
  const customAccentLabel = t('pet.fieldAccentCustom');

  // Apply the draft theme immediately so the user sees a live preview
  // before hitting Save. SettingsDialog's cleanup reverts this on cancel.
  useLayoutEffect(() => {
    applyAppearanceToDocument({
      theme: current,
      accentColor: currentAccent,
    });
  }, [current, currentAccent]);

  const setAccentColor = (color: string) => {
    setCfg((c) => ({ ...c, accentColor: normalizeAccentColor(color) ?? c.accentColor ?? DEFAULT_ACCENT_COLOR }));
  };

  return (
    <section className="settings-section">
      <div className="seg-control" role="group" aria-label={t('settings.appearance')} style={{ '--seg-cols': THEMES.length } as React.CSSProperties}>
        {THEMES.map(({ value, labelKey, icon }) => (
          <button
            key={value}
            type="button"
            className={'seg-btn' + (current === value ? ' active' : '')}
            aria-pressed={current === value}
            onClick={() => {
              // P1 ui_click area=appearance — `system|light|dark` only
              // emits from the segmented control; accent swatch picks
              // use `accent_color` with the swatch hex below.
              if (value === 'system' || value === 'light' || value === 'dark') {
                trackSettingsAppearanceClick(analytics.track, {
                  page_name: 'settings',
                  area: 'appearance',
                  element: value,
                });
              }
              setCfg((c) => ({ ...c, theme: value }));
            }}
          >
            {icon ? <Icon name={icon} size={14} aria-hidden="true" /> : null}
            <span className="seg-title">{t(labelKey)}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <span className="field-label">{accentLabel}</span>
        <div className="pet-swatches" role="radiogroup" aria-label={accentLabel}>
          {ACCENT_SWATCHES.map((color) => {
            const active = currentAccent === color;
            return (
              <button
                key={color}
                type="button"
                className={`pet-swatch${active ? ' active' : ''}`}
                style={{ background: color }}
                aria-label={color === DEFAULT_ACCENT_COLOR ? defaultAccentLabel : color}
                aria-checked={active}
                role="radio"
                onClick={() => {
                  trackSettingsAppearanceClick(analytics.track, {
                    page_name: 'settings',
                    area: 'appearance',
                    element: 'accent_color',
                    color,
                  });
                  setAccentColor(color);
                }}
              />
            );
          })}
          <input
            type="color"
            aria-label={customAccentLabel}
            className="pet-swatch-picker"
            value={currentAccent}
            onChange={(e) => setAccentColor(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Settings surface for the M1 Critique Theater rollout toggle.
 *
 * The toggle has two halves on opposite sides of the HTTP boundary:
 *
 *   * Browser-side: `useCritiqueTheaterEnabled` reads / writes the
 *     `open-design:config` localStorage blob; this is what gates
 *     whether `<CritiqueTheaterMount>` actually renders.
 *   * Daemon-side: the rollout resolver in `server.ts` reads
 *     `project.metadata.critiqueTheaterEnabled`, so the daemon only
 *     routes runs through the critique pipeline when the active
 *     project's metadata row says yes (or env / phase / skill policy
 *     overrides it).
 *
 * If we only wrote localStorage, the user would see the mount but
 * every generation would still skip the critique pipeline server-side
 * (Codex + lefarcen P1 on PR #1484). To keep the two halves in
 * lockstep, the setter takes an optional `{ projectId }` and, when
 * provided, does the read-merge-write PATCH on the project's metadata
 * (already shipped by Phase 15 and exercised by the wireup PR).
 *
 * This section threads the currently-open project id when the dialog
 * is opened from `/projects/:id`. When opened from the entry gallery
 * (`/`), the toggle is localStorage-only, and a contextual hint tells
 * the user that per-project persistence requires opening a project
 * first. That matches the actual scope of the wire-up.
 */
function CritiqueTheaterSection() {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const enabled = useCritiqueTheaterEnabled();
  const route = useRoute();
  const activeProjectId = route.kind === 'project' ? route.projectId : null;
  return (
    <section className="settings-section">
      <div className="section-head">
        <div>
          <h3>{t('critiqueTheater.settingsNav')}</h3>
          <p className="hint">{t('critiqueTheater.settingsNavHint')}</p>
        </div>
      </div>
      <label className="field">
        <span className="field-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              const next = e.target.checked;
              trackSettingsDesignReviewClick(analytics.track, {
                page_name: 'settings',
                area: 'design_review',
                element: 'enable_toggle',
                status_before: enabled ? 'on' : 'off',
                status_after: next ? 'on' : 'off',
                has_active_project: activeProjectId !== null,
              });
              if (activeProjectId !== null) {
                void setCritiqueTheaterEnabled(next, { projectId: activeProjectId });
              } else {
                void setCritiqueTheaterEnabled(next);
              }
            }}
          />
          {' '}
          {t('critiqueTheater.settingsEnabledLabel')}
        </span>
        <small className="hint">
          {t('critiqueTheater.settingsEnabledDescription')}
        </small>
        {activeProjectId !== null ? (
          <small className="hint">
            {t('critiqueTheater.settingsEnabledProjectHint')}
          </small>
        ) : (
          <small className="hint">
            {t('critiqueTheater.settingsEnabledNoProjectHint')}
          </small>
        )}
      </label>
    </section>
  );
}

// Map the runtime SoundId (hyphenated, used by utils/notifications.ts) onto
// the contract's underscored enum. Sounds that don't have a tracking entry
// drop to undefined so we never emit an off-enum value.
function soundIdToTracking(
  id: string,
):
  | 'ding'
  | 'chime'
  | 'two_tone_up'
  | 'pluck'
  | 'buzz'
  | 'two_tone_down'
  | 'thud'
  | undefined {
  switch (id) {
    case 'ding':
      return 'ding';
    case 'chime':
      return 'chime';
    case 'two-tone-up':
      return 'two_tone_up';
    case 'pluck':
      return 'pluck';
    case 'buzz':
      return 'buzz';
    case 'two-tone-down':
      return 'two_tone_down';
    case 'thud':
      return 'thud';
    default:
      return undefined;
  }
}

function NotificationsSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const notif = cfg.notifications ?? DEFAULT_NOTIFICATIONS;
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    () => notificationPermission(),
  );
  const [testStatus, setTestStatus] = useState<ReturnType<typeof testNotificationStatusText> | null>(null);

  const updateNotif = (
    patch: Partial<NonNullable<AppConfig['notifications']>>,
  ) => {
    setCfg((c) => ({
      ...c,
      notifications: { ...DEFAULT_NOTIFICATIONS, ...(c.notifications ?? {}), ...patch },
    }));
  };

  const toggleSound = () => {
    const next = !notif.soundEnabled;
    // P1 ui_click area=notifications element=completion_sound — the toggle
    // emits the post-click state on `completion_sound_status` so a single
    // event captures intent + outcome.
    trackSettingsNotificationsClick(analytics.track, {
      page_name: 'settings',
      area: 'notifications',
      element: 'completion_sound',
      completion_sound_status: next ? 'on' : 'off',
    });
    updateNotif({ soundEnabled: next });
    // Give the user immediate audible feedback when turning the master
    // switch on so they know which sound they're signing up for. Resuming
    // the AudioContext also bakes in their gesture for later auto-plays.
    if (next) playSound(notif.successSoundId);
  };

  const toggleDesktop = async () => {
    if (notif.desktopEnabled) {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'off',
      });
      updateNotif({ desktopEnabled: false });
      return;
    }
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'on',
      });
      updateNotif({ desktopEnabled: true });
    } else {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'off',
      });
      updateNotif({ desktopEnabled: false });
    }
  };

  const sendTestNotification = async () => {
    const result = await showCompletionNotification({
      status: 'succeeded',
      title: t('notify.successTitle'),
      body: t('notify.successBody'),
    });
    setPermission(notificationPermission());
    setTestStatus(testNotificationStatusText(result));
  };

  return (
    <section className="settings-section">
      <div className="settings-subsection">
        <div className="settings-notify-card">
          <div className="settings-notify-card-header">
            <h4>{t('settings.notifyCompletionSound')}</h4>
            <div className="section-head-actions">
              <div className="seg-control" role="group" aria-label={t('settings.notifyCompletionSound')} style={{ '--seg-cols': 1 } as React.CSSProperties}>
                <button
                  type="button"
                  className={'seg-btn' + (notif.soundEnabled ? ' active' : '')}
                  aria-pressed={notif.soundEnabled}
                  onClick={toggleSound}
                >
                  <span className="seg-title">{notif.soundEnabled ? t('common.active') : t('common.offline')}</span>
                </button>
              </div>
            </div>
          </div>
          <p className="hint settings-notify-card-hint">{t('settings.notifyCompletionSoundHint')}</p>
        </div>

        {notif.soundEnabled ? (
          <>
            <div className="settings-field">
              <label>{t('settings.notifySuccessSound')}</label>
              <div className="seg-control" role="group" aria-label={t('settings.notifySuccessSound')} style={{ '--seg-cols': SUCCESS_SOUNDS.length } as React.CSSProperties}>
                {SUCCESS_SOUNDS.map((sound) => (
                  <button
                    key={sound.id}
                    type="button"
                    className={'seg-btn' + (notif.successSoundId === sound.id ? ' active' : '')}
                    aria-pressed={notif.successSoundId === sound.id}
                    onClick={() => {
                      const trackingSoundId = soundIdToTracking(sound.id);
                      trackSettingsNotificationsClick(analytics.track, {
                        page_name: 'settings',
                        area: 'notifications',
                        element: 'success_sound',
                        ...(trackingSoundId ? { sound_id: trackingSoundId } : {}),
                      });
                      updateNotif({ successSoundId: sound.id });
                      playSound(sound.id);
                    }}
                  >
                    <span className="seg-title">{t(sound.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-field">
              <label>{t('settings.notifyFailureSound')}</label>
              <div className="seg-control" role="group" aria-label={t('settings.notifyFailureSound')} style={{ '--seg-cols': FAILURE_SOUNDS.length } as React.CSSProperties}>
                {FAILURE_SOUNDS.map((sound) => (
                  <button
                    key={sound.id}
                    type="button"
                    className={'seg-btn' + (notif.failureSoundId === sound.id ? ' active' : '')}
                    aria-pressed={notif.failureSoundId === sound.id}
                    onClick={() => {
                      const trackingSoundId = soundIdToTracking(sound.id);
                      trackSettingsNotificationsClick(analytics.track, {
                        page_name: 'settings',
                        area: 'notifications',
                        element: 'failure_sound',
                        ...(trackingSoundId ? { sound_id: trackingSoundId } : {}),
                      });
                      updateNotif({ failureSoundId: sound.id });
                      playSound(sound.id);
                    }}
                  >
                    <span className="seg-title">{t(sound.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="settings-subsection">
        <div className="settings-notify-card">
          <div className="settings-notify-card-header">
            <h4>{t('settings.notifyDesktop')}</h4>
            <div className="section-head-actions">
              <div className="seg-control" role="group" aria-label={t('settings.notifyDesktop')} style={{ '--seg-cols': 1 } as React.CSSProperties}>
                <button
                  type="button"
                  className={'seg-btn' + (notif.desktopEnabled ? ' active' : '')}
                  aria-pressed={notif.desktopEnabled}
                  disabled={permission === 'unsupported'}
                  onClick={() => { void toggleDesktop(); }}
                >
                  <span className="seg-title">{notif.desktopEnabled ? t('common.active') : t('common.offline')}</span>
                </button>
              </div>
            </div>
          </div>
          <p className="hint settings-notify-card-hint">{t('settings.notifyDesktopHint')}</p>
        </div>
        {permission === 'unsupported' ? (
          <p className="hint">{t('settings.notifyDesktopUnsupported')}</p>
        ) : null}
        {permission === 'denied' ? (
          <p className="hint">{t('settings.notifyDesktopBlocked')}</p>
        ) : null}
        {notif.desktopEnabled && permission === 'granted' ? (
          <>
            <Button variant="ghost" onClick={() => {
              trackSettingsNotificationsClick(analytics.track, {
                page_name: 'settings',
                area: 'notifications',
                element: 'send_test',
              });
              void sendTestNotification();
            }}>
              {t('settings.notifyTest')}
            </Button>
            {testStatus ? <p className="hint" role="status">{t(testStatus)}</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function testNotificationStatusText(
  result: Awaited<ReturnType<typeof showCompletionNotification>>,
):
  | 'settings.notifyTestSent'
  | 'settings.notifyDesktopBlocked'
  | 'settings.notifyDesktopUnsupported'
  | 'settings.notifyTestFailed' {
  if (result === 'shown') return 'settings.notifyTestSent';
  if (result === 'permission-denied') return 'settings.notifyDesktopBlocked';
  if (result === 'unsupported') return 'settings.notifyDesktopUnsupported';
  return 'settings.notifyTestFailed';
}
