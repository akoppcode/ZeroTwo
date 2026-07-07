// InlineModelSwitcher — top-bar chip exposing the Local CLI agent + model picker.
//
// Lives in the entry view's sticky top-bar so users can swap the active
// local CLI agent (and its model) without having to open the full Settings
// dialog. The chip is intentionally narrow — it shows the active agent and
// model in one line and opens a compact popover for switching. All
// persistence is delegated upward through the same callbacks `AvatarMenu`
// already uses, so the switcher inherits autosave + daemon sync without
// re-implementing it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  agentIdToTracking,
  modelIdForTracking,
} from '@open-design/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import { trackExecutionSettingsPopoverClick } from '../analytics/events';
import type { AgentInfo, AppConfig } from '../types';
import { AgentIcon } from './AgentIcon';
import { Icon } from './Icon';
import { SearchableModelSelect } from './modelOptions';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  compact?: boolean;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onOpenSettings: (
    section?:
      | 'execution'
      | 'language'
      | 'appearance'
      | 'notifications'
      | 'pet'
      | 'about',
  ) => void;
}

export function InlineModelSwitcher({
  config,
  agents,
  compact = false,
  onAgentChange,
  onAgentModelChange,
  onOpenSettings,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const handleAgentButtonClick = useCallback(
    (agentId: string) => {
      trackExecutionSettingsPopoverClick(analytics.track, {
        page_name: 'home',
        area: 'execution_settings_popover',
        element: 'agent_card',
        cli_provider_id: agentIdToTracking(agentId),
      });
      onAgentChange?.(agentId);
    },
    [analytics.track, onAgentChange],
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      const target = e.target as Node;
      if (wrapRef.current.contains(target)) return;
      // The model picker (`SearchableModelSelect`) renders its option list in a
      // portal on `document.body`, so a click on an option lands OUTSIDE
      // `wrapRef`. Without this guard the mousedown would close the whole
      // switcher panel before the option's click fires, unmounting the picker
      // and dropping the selection — the model would never change.
      if (
        target instanceof Element &&
        target.closest('.model-select-searchable__popover')
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const installedAgents = useMemo(
    () => agents.filter((a) => a.available),
    [agents],
  );
  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );

  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const currentModelId =
    (typeof currentChoice.model === 'string' && currentChoice.model
      ? currentChoice.model
      : null) ?? currentAgent?.models?.[0]?.id ?? null;
  const currentModelLabel =
    currentAgent?.models?.find((m) => m.id === currentModelId)?.label ?? null;

  // Chip text — keep it tight so the pill doesn't wrap on small viewports.
  // e.g. "Local CLI · Claude · Sonnet 4.5".
  const chipMode = t('inlineSwitcher.chipCli');
  const chipPrimary = currentAgent
    ? currentAgent.name
    : t('inlineSwitcher.noAgent');
  const chipModel =
    currentModelLabel && currentModelId !== 'default'
      ? currentModelLabel
      : t('inlineSwitcher.modelDefault');

  return (
    <div
      className={`inline-switcher${compact ? ' inline-switcher--compact' : ''}`}
      ref={wrapRef}
      data-testid="inline-model-switcher"
    >
      <button
        type="button"
        className="inline-switcher__chip od-tooltip"
        data-testid="inline-model-switcher-chip"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${chipMode} · ${chipPrimary} · ${chipModel}`}
        data-tooltip={`${chipMode} · ${chipPrimary} · ${chipModel}`}
        data-tooltip-placement="bottom"
      >
        <span className="inline-switcher__chip-icon" aria-hidden="true">
          {currentAgent ? (
            <AgentIcon id={currentAgent.id} size={18} />
          ) : (
            <span className="inline-switcher__chip-glyph">
              <Icon name="link" size={12} />
            </span>
          )}
        </span>
        <span className="inline-switcher__chip-text">
          <span className="inline-switcher__chip-mode">{chipMode}</span>
          <span className="inline-switcher__chip-sep" aria-hidden="true">
            ·
          </span>
          <span className="inline-switcher__chip-primary">{chipPrimary}</span>
          <span className="inline-switcher__chip-sep" aria-hidden="true">
            ·
          </span>
          <span className="inline-switcher__chip-model">{chipModel}</span>
        </span>
        <Icon
          name="chevron-down"
          size={12}
          className="inline-switcher__chip-chevron"
        />
      </button>

      {open ? (
        <div
          className="inline-switcher__popover"
          role="menu"
          data-testid="inline-model-switcher-popover"
        >
          <div className="inline-switcher__row">
            <span className="inline-switcher__label">
              {t('inlineSwitcher.agentLabel')}
            </span>
            {installedAgents.length === 0 ? (
              <span className="inline-switcher__hint">
                {t('inlineSwitcher.noAgentsDetected')}
              </span>
            ) : (
              <div className="inline-switcher__agent-grid" role="radiogroup">
                {installedAgents.map((a) => {
                  const active = config.agentId === a.id;
                  return (
                    <div key={a.id} className="inline-switcher__agent-row">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={a.name}
                        className={
                          'inline-switcher__agent' + (active ? ' is-active' : '')
                        }
                        data-testid={`inline-model-switcher-agent-${a.id}`}
                        onClick={() => handleAgentButtonClick(a.id)}
                        title={a.version ? `${a.name} · ${a.version}` : a.name}
                      >
                        <AgentIcon id={a.id} size={20} />
                        <span className="inline-switcher__agent-name">
                          {a.name}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {currentAgent &&
          currentAgent.models &&
          currentAgent.models.length > 0 ? (
            <div className="inline-switcher__row">
              <span className="inline-switcher__label">
                {t('inlineSwitcher.modelLabel')}
              </span>
              <SearchableModelSelect
                className="inline-switcher__select"
                data-testid="inline-model-switcher-agent-model"
                searchInputTestId="inline-model-switcher-agent-model-search"
                popoverTestId="inline-model-switcher-agent-model-popover"
                searchPlaceholder={t('designs.searchPlaceholder')}
                aria-label={t('inlineSwitcher.modelLabel')}
                models={currentAgent.models}
                value={currentModelId ?? ''}
                onChange={(nextValue) => {
                  trackExecutionSettingsPopoverClick(analytics.track, {
                    page_name: 'home',
                    area: 'execution_settings_popover',
                    element: 'model_dropdown',
                    execution_mode: 'local_cli',
                    model_id: modelIdForTracking(nextValue),
                  });
                  onAgentModelChange?.(currentAgent.id, {
                    model: nextValue,
                  });
                }}
                additionalOptions={
                  currentModelId &&
                  !currentAgent.models.some((m) => m.id === currentModelId)
                    ? [
                        {
                          value: currentModelId,
                          label: `${currentModelId} ${t('inlineSwitcher.customSuffix')}`,
                        },
                      ]
                    : undefined
                }
              />
            </div>
          ) : null}

          <button
            type="button"
            className="inline-switcher__more"
            data-testid="inline-model-switcher-open-settings"
            onClick={() => {
              trackExecutionSettingsPopoverClick(analytics.track, {
                page_name: 'home',
                area: 'execution_settings_popover',
                element: 'open_execution_settings',
              });
              setOpen(false);
              onOpenSettings?.('execution');
            }}
          >
            <Icon name="settings" size={13} />
            <span>{t('inlineSwitcher.openFullSettings')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
