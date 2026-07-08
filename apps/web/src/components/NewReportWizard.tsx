// New report wizard (design spec §3.3).
//
// Three steps: Basics (name, folder, agent) → Brief (a large free-text field
// with ghost examples) → Ready (provisioning, spec §3.6). "Create" scaffolds a
// fresh PBIR project via POST /api/projects/scaffold and advances to Ready,
// where the shared ProvisioningPanel installs the Power BI skills before
// "Open workspace" hands off to the project. The Brief text is captured but the
// planning conversation that consumes it is a later phase.

import { useCallback, useState } from 'react';
import { Icon } from './Icon';
import type { ReportPage } from './pipeline-types';
import { ProvisioningPanel } from './ProvisioningPanel';
import { ZeroTwoAgentPicker, type ZeroTwoAgent } from './ZeroTwoAgentPicker';
import { ZeroTwoWizardModal } from './ZeroTwoWizardModal';

type NewStep = 'basics' | 'brief' | 'ready';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpened?: (projectId: string) => void;
  /** Called with the scaffolded project id + report page inventory (spec §7 preview). */
  onReportInventory?: (projectId: string, pages: ReportPage[]) => void;
  defaultAgent?: ZeroTwoAgent;
}

const BRIEF_PLACEHOLDER = [
  'e.g. Executive sales overview for regional managers. KPIs: revenue vs target,',
  'win rate, pipeline coverage. Source: the Sales.SemanticModel. Style: clean IBCS',
  'variance charts, dark theme, one page.',
].join(' ');

export function NewReportWizard({ open, onClose, onOpened, onReportInventory, defaultAgent = 'claude' }: Props) {
  const [step, setStep] = useState<NewStep>('basics');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [agent, setAgent] = useState<ZeroTwoAgent>(defaultAgent);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [reportPages, setReportPages] = useState<ReportPage[]>([]);

  const reset = useCallback(() => {
    setStep('basics');
    setName('');
    setFolder('');
    setAgent(defaultAgent);
    setBrief('');
    setBusy(false);
    setError(null);
    setProjectId(null);
    setReportPages([]);
  }, [defaultAgent]);

  const close = useCallback(() => {
    onClose();
    setTimeout(reset, 200);
  }, [onClose, reset]);

  const canContinue = name.trim().length > 0 && folder.trim().length > 0;

  // Scaffold the project, then advance to Ready so provisioning runs against the
  // just-created folder before the workspace opens (spec §3.3 step 3).
  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // TODO(Phase 3+): forward `brief` to the planning conversation once the
        // workspace planning chat exists; scaffold only needs name/path/agent.
        body: JSON.stringify({ name: name.trim(), path: folder.trim(), agent }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { project: { id: string }; report?: { pages?: ReportPage[] } };
        setProjectId(body.project.id);
        setReportPages(body.report?.pages ?? []);
        setStep('ready');
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? `Could not create the report (HTTP ${res.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the report.');
    } finally {
      setBusy(false);
    }
  }, [name, folder, agent]);

  const openWorkspace = useCallback(() => {
    if (projectId) {
      onReportInventory?.(projectId, reportPages);
      onOpened?.(projectId);
    }
    close();
  }, [projectId, reportPages, onOpened, onReportInventory, close]);

  return (
    <ZeroTwoWizardModal
      open={open}
      title="New report"
      subtitle="Scaffold a fresh PBIR project and describe what you want to build."
      onClose={close}
      testId="new-report-wizard"
    >
      {step === 'basics' ? (
        <div className="zt-step" data-testid="new-step-basics">
          <label className="zt-field">
            <span className="zt-field__label">Report name</span>
            <input
              type="text"
              className="zt-input"
              placeholder="Q3 Revenue Review"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="new-name-input"
            />
          </label>
          <label className="zt-field">
            <span className="zt-field__label">Folder</span>
            <input
              type="text"
              className="zt-input"
              placeholder="C:\PowerBIProjects\q3-review"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              data-testid="new-folder-input"
            />
            <span className="zt-field__hint">The PBIP project is created here.</span>
          </label>
          <label className="zt-field">
            <span className="zt-field__label">Agent</span>
            <ZeroTwoAgentPicker value={agent} onChange={setAgent} idBase="new-agent" />
          </label>
          <button
            type="button"
            className="zt-btn zt-btn--primary"
            disabled={!canContinue}
            onClick={() => setStep('brief')}
            data-testid="new-continue"
          >
            Continue
          </button>
        </div>
      ) : null}

      {step === 'brief' ? (
        <div className="zt-step" data-testid="new-step-brief">
          <label className="zt-field">
            <span className="zt-field__label">Brief</span>
            <textarea
              className="zt-textarea"
              rows={7}
              placeholder={BRIEF_PLACEHOLDER}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              data-testid="new-brief-input"
            />
            <span className="zt-field__hint">
              Describe the report: audience, KPIs, data, style. The agent will turn this into a plan.
            </span>
          </label>

          {error ? (
            <div className="zt-notice zt-notice--error" role="alert" data-testid="new-error">
              <Icon name="alert-triangle" size={16} />
              <p className="zt-notice__text">{error}</p>
            </div>
          ) : null}

          <div className="zt-actions">
            <button type="button" className="zt-btn zt-btn--ghost" onClick={() => setStep('basics')}>
              Back
            </button>
            <button
              type="button"
              className="zt-btn zt-btn--primary"
              onClick={() => void create()}
              disabled={busy}
              data-testid="new-create"
            >
              {busy ? <Icon name="spinner" size={14} /> : null}
              <span>Create</span>
            </button>
          </div>
        </div>
      ) : null}

      {step === 'ready' ? (
        <div className="zt-step" data-testid="new-step-ready">
          <div className="zt-summary">
            <div className="zt-summary__row">
              <span className="zt-summary__label">Report</span>
              <span className="zt-summary__value">{name}</span>
            </div>
            <div className="zt-summary__row">
              <span className="zt-summary__label">Folder</span>
              <code className="zt-summary__value">{folder}</code>
            </div>
            <div className="zt-summary__row">
              <span className="zt-summary__label">Agent</span>
              <span className="zt-summary__value">{agent === 'claude' ? 'Claude Code' : 'Copilot'}</span>
            </div>
          </div>

          <ProvisioningPanel agent={agent} projectPath={folder.trim()} />

          <button
            type="button"
            className="zt-btn zt-btn--primary"
            onClick={openWorkspace}
            data-testid="new-open-workspace"
          >
            <span>Open workspace</span>
          </button>
        </div>
      ) : null}
    </ZeroTwoWizardModal>
  );
}
