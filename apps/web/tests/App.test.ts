import { describe, expect, it } from 'vitest';

import {
  buildPersistedConfig,
  isAutosaveDraftOnlyChange,
  resolveSettingsCloseConfig,
} from '../src/App';
import type { AppConfig } from '../src/types';

const baseConfig: AppConfig = {
  agentId: null,
  skillId: null,
  designSystemId: null,
};

describe('buildPersistedConfig', () => {
  it('preserves onboarding completion when a stale autosave snapshot says false', () => {
    expect(
      buildPersistedConfig(
        { ...baseConfig, onboardingCompleted: false },
        { ...baseConfig, onboardingCompleted: true },
      ),
    ).toMatchObject({ onboardingCompleted: true });
  });

  it('preserves a current privacy decision when settings autosaves a stale pre-consent snapshot', () => {
    expect(
      buildPersistedConfig(
        {
          ...baseConfig,
          theme: 'dark',
          privacyDecisionAt: null,
          telemetry: { metrics: true, content: true, artifactManifest: false },
        },
        {
          ...baseConfig,
          installationId: 'inst-current',
          privacyDecisionAt: 12345,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      ),
    ).toMatchObject({
      theme: 'dark',
      installationId: 'inst-current',
      privacyDecisionAt: 12345,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    });
  });
});

describe('isAutosaveDraftOnlyChange', () => {
  it('flags a real change as persist-worthy', () => {
    const flipped: AppConfig = { ...baseConfig, theme: 'dark' };
    expect(isAutosaveDraftOnlyChange(flipped, baseConfig)).toBe(false);
  });

  it('returns true for an identical snapshot (no-op autosave tick)', () => {
    expect(isAutosaveDraftOnlyChange(baseConfig, baseConfig)).toBe(true);
  });
});

describe('resolveSettingsCloseConfig', () => {
  it('marks onboarding complete without discarding the latest persisted draft', () => {
    expect(
      resolveSettingsCloseConfig(
        {
          ...baseConfig,
          onboardingCompleted: false,
          orbit: { enabled: false, time: '09:00', templateSkillId: 'stale-template' },
        },
        {
          ...baseConfig,
          onboardingCompleted: false,
          orbit: { enabled: true, time: '11:30', templateSkillId: 'fresh-template' },
        },
      ),
    ).toMatchObject({
      onboardingCompleted: true,
      orbit: { enabled: true, time: '11:30', templateSkillId: 'fresh-template' },
    });
  });
});
