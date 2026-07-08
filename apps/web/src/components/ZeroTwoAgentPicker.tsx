// Agent segmented control shared by the Zero Two wizards.
//
// Two options (Claude Code / Copilot) matching the daemon's ProjectAgent
// contract. Sign-in state is Phase 3 (provisioning) — omitted here on purpose.

import { Icon } from './Icon';

export type ZeroTwoAgent = 'claude' | 'copilot';

const OPTIONS: Array<{ id: ZeroTwoAgent; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'copilot', label: 'Copilot' },
];

interface Props {
  value: ZeroTwoAgent;
  onChange: (agent: ZeroTwoAgent) => void;
  disabled?: boolean;
  idBase?: string;
}

export function ZeroTwoAgentPicker({ value, onChange, disabled, idBase = 'zt-agent' }: Props) {
  return (
    <div className="zt-agent-picker" role="radiogroup" aria-label="Agent">
      {OPTIONS.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            id={`${idBase}-${option.id}`}
            type="button"
            role="radio"
            aria-checked={active}
            className={`zt-agent-picker__option${active ? ' is-active' : ''}`}
            onClick={() => onChange(option.id)}
            disabled={disabled}
            data-testid={`${idBase}-${option.id}`}
          >
            <Icon name={active ? 'check' : 'terminal'} size={14} />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
