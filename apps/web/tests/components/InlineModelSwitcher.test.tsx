// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

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

const baseConfig: AppConfig = {
  agentId: 'claude',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

const claudeAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '2.1.131',
  models: [
    { id: 'default', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet (alias)' },
    { id: 'opus', label: 'Opus (alias)' },
  ],
};

const copilotAgent: AgentInfo = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  bin: 'copilot',
  available: true,
  version: '0.5.0',
  models: [{ id: 'default', label: 'Default' }],
};

function renderSwitcher(
  config: Partial<AppConfig> = {},
  agents: AgentInfo[] = [claudeAgent, copilotAgent],
  options: { compact?: boolean } = {},
) {
  const onAgentChange = vi.fn();
  const onAgentModelChange = vi.fn();
  const onOpenSettings = vi.fn();
  const view = render(
    <InlineModelSwitcher
      config={{ ...baseConfig, ...config }}
      agents={agents}
      compact={options.compact}
      onAgentChange={onAgentChange}
      onAgentModelChange={onAgentModelChange}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { ...view, onAgentChange, onAgentModelChange, onOpenSettings };
}

describe('InlineModelSwitcher', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps an accessible name on the chip when the icon-only treatment hides its text', () => {
    // Regression: in the icon-only topbar treatment `.inline-switcher__chip-text`
    // is `display: none`, so the visible label is removed from the accessibility
    // tree. The button must still expose a real accessible name (CLI/model state)
    // for screen-reader users, not just an icon plus a `data-tooltip` hint.
    renderSwitcher();

    const chip = screen.getByRole('button', {
      name: /Claude Code/i,
    });
    expect(chip).toBe(screen.getByTestId('inline-model-switcher-chip'));
    expect(chip.getAttribute('aria-label')).toMatch(/·/u);
  });

  it('can render the compact home-hero chip variant', () => {
    renderSwitcher({}, [claudeAgent, copilotAgent], { compact: true });

    expect(screen.getByTestId('inline-model-switcher').className).toContain(
      'inline-switcher--compact',
    );
  });

  it('lists installed agents and routes a card click through onAgentChange', () => {
    const { onAgentChange } = renderSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const popover = screen.getByTestId('inline-model-switcher-popover');
    expect(
      within(popover).getByTestId('inline-model-switcher-agent-claude'),
    ).toBeTruthy();
    fireEvent.click(
      within(popover).getByTestId('inline-model-switcher-agent-copilot'),
    );

    expect(onAgentChange).toHaveBeenCalledWith('copilot');
  });

  it('shows a hint when no CLI agents are installed', () => {
    renderSwitcher({}, [{ ...claudeAgent, available: false }]);

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const popover = screen.getByTestId('inline-model-switcher-popover');
    expect(popover.querySelector('.inline-switcher__hint')).toBeTruthy();
    expect(
      within(popover).queryByTestId('inline-model-switcher-agent-claude'),
    ).toBeNull();
  });

  it('lists the active agent models and applies a model switch', () => {
    const { onAgentModelChange } = renderSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const modelPicker = screen.getByTestId('inline-model-switcher-agent-model');
    expect(modelPicker.textContent).toContain('Default');
    fireEvent.click(modelPicker);
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-agent-model-popover',
    );
    expect(optionNames(modelPopover)).toEqual([
      'Default',
      'Sonnet (alias)',
      'Opus (alias)',
    ]);

    fireEvent.click(
      within(modelPopover).getByRole('option', { name: 'Opus (alias)' }),
    );
    expect(onAgentModelChange).toHaveBeenCalledWith('claude', { model: 'opus' });
  });

  it('keeps a custom saved model selectable when it is not in the declared list', () => {
    renderSwitcher({
      agentModels: { claude: { model: 'custom-claude-model' } },
    });

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const modelPicker = screen.getByTestId('inline-model-switcher-agent-model');
    expect(modelPicker.textContent).toContain('custom-claude-model');
    fireEvent.click(modelPicker);
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-agent-model-popover',
    );
    expect(
      within(modelPopover).getByRole('option', { name: /custom-claude-model/i }),
    ).toBeTruthy();
  });

  it('keeps the panel open and applies the choice when picking a model from the portaled list', () => {
    // Regression: the model list renders in a portal on `document.body`, so a
    // mousedown on an option lands OUTSIDE the switcher's `wrapRef`. The panel's
    // outside-click handler used to close the whole panel on that mousedown,
    // unmounting the picker before its click fired — the model never changed.
    const { onAgentModelChange } = renderSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));

    const modelPopover = screen.getByTestId(
      'inline-model-switcher-agent-model-popover',
    );
    const option = within(modelPopover).getByRole('option', {
      name: 'Sonnet (alias)',
    });

    // The real browser fires mousedown before the option's click. The panel's
    // document-level mousedown listener must NOT treat this portal click as
    // "outside" and close the switcher.
    fireEvent.mouseDown(option);
    expect(screen.queryByTestId('inline-model-switcher-popover')).not.toBeNull();
    expect(
      screen.queryByTestId('inline-model-switcher-agent-model-popover'),
    ).not.toBeNull();

    fireEvent.click(option);
    expect(onAgentModelChange).toHaveBeenCalledWith('claude', {
      model: 'sonnet',
    });
  });

  it('opens execution settings from the popover footer action', () => {
    const { onOpenSettings } = renderSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-open-settings'));

    expect(onOpenSettings).toHaveBeenCalledWith('execution');
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });
});
