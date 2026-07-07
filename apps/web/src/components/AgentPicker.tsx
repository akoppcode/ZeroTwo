import { Button, Select } from '@open-design/components';
import { useT } from '../i18n';
import type { AgentInfo } from '../types';

interface Props {
  agents: AgentInfo[];
  agentId: string | null;
  onAgentChange: (id: string) => void;
  onRefresh: () => void;
}

export function AgentPicker({
  agents,
  agentId,
  onAgentChange,
  onRefresh,
}: Props) {
  const t = useT();
  const available = agents.filter((a) => a.available);
  const currentAgent = agents.find((a) => a.id === agentId);

  return (
    <div className="picker agent-picker">
      <span className="picker-label">{t('agentPicker.label')}</span>
      <Select
        value={agentId ?? ''}
        onChange={(e) => onAgentChange(e.target.value)}
        disabled={available.length === 0}
        title={
          currentAgent?.version
            ? `${currentAgent.name} · ${currentAgent.version}`
            : t('agentPicker.selectAgent')
        }
      >
        {available.length === 0 ? (
          <option value="">{t('agentPicker.noAgents')}</option>
        ) : null}
        {agents.map((a) => (
          <option key={a.id} value={a.id} disabled={!a.available}>
            {a.name}
            {a.available ? '' : ` · ${t('agentPicker.notInstalled')}`}
          </option>
        ))}
      </Select>
      <Button
        size="icon"
        onClick={onRefresh}
        title={t('agentPicker.rescan')}
      >
        ↻
      </Button>
    </div>
  );
}
