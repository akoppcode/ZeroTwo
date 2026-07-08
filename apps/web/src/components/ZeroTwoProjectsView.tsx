// Zero Two projects home (design spec §3.1) — the entry surface for the Phase 2
// wizards. Renders the two primary paths (Attach a report / New report) and
// hosts both wizard modals. Wired into the entry shell the same rail/route way
// as DoctorView.

import { useState } from 'react';
import { AttachReportWizard } from './AttachReportWizard';
import { Icon, type IconName } from './Icon';
import { NewReportWizard } from './NewReportWizard';
import { PipelinePanel } from './PipelinePanel';
import { RulesStudio } from './RulesStudio';
import type { ReportPage } from './pipeline-types';

interface Props {
  /** Switch to the Doctor route (tertiary "environment check" affordance). */
  onOpenDoctor?: () => void;
  /** Open the workspace for a freshly attached / scaffolded project. */
  onOpenProject?: (projectId: string) => void;
}

interface PathCard {
  id: 'attach' | 'new';
  icon: IconName;
  title: string;
  description: string;
  cta: string;
}

const PATHS: PathCard[] = [
  {
    id: 'attach',
    icon: 'import',
    title: 'Attach a report',
    description: 'Convert an existing .pbix into a source-controlled PBIP project, or point Zero Two at a PBIP folder you already have.',
    cta: 'Attach a report',
  },
  {
    id: 'new',
    icon: 'plus',
    title: 'New report',
    description: 'Scaffold a fresh PBIR project and brief the agent on what to build.',
    cta: 'Start from scratch',
  },
];

export function ZeroTwoProjectsView({ onOpenDoctor, onOpenProject }: Props) {
  const [attachOpen, setAttachOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // Phase 4: once a project is attached / scaffolded, open its pipeline preview
  // inline. Phase 6 adds a Rules surface for the same project.
  // TODO(Workspace phase): the Workspace shell will own this Preview/Rules nav
  // and the project/session context — this inline toggle is a stopgap.
  const [pipeline, setPipeline] = useState<{ projectId: string; pages: ReportPage[] } | null>(null);
  const [projectTab, setProjectTab] = useState<'pipeline' | 'rules'>('pipeline');

  const openPipeline = (projectId: string, pages: ReportPage[]) => {
    setAttachOpen(false);
    setNewOpen(false);
    setProjectTab('pipeline');
    setPipeline({ projectId, pages });
  };

  if (pipeline) {
    return (
      <section className="zt-projects" aria-labelledby="zt-projects-title" data-testid="zero-two-projects-view">
        <div className="zt-projects__subnav">
          <button
            type="button"
            className="zt-btn zt-btn--ghost"
            onClick={() => setPipeline(null)}
            data-testid="zt-project-back"
          >
            <Icon name="chevron-left" size={14} />
            <span>Back to reports</span>
          </button>
          <div className="zt-rules__mode" role="tablist" aria-label="Project surface">
            <button
              type="button"
              role="tab"
              aria-selected={projectTab === 'pipeline'}
              className={`zt-rules__mode-btn${projectTab === 'pipeline' ? ' is-active' : ''}`}
              onClick={() => setProjectTab('pipeline')}
              data-testid="zt-tab-pipeline"
            >
              Preview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={projectTab === 'rules'}
              className={`zt-rules__mode-btn${projectTab === 'rules' ? ' is-active' : ''}`}
              onClick={() => setProjectTab('rules')}
              data-testid="zt-tab-rules"
            >
              Rules
            </button>
          </div>
        </div>
        {projectTab === 'pipeline' ? (
          <PipelinePanel
            projectId={pipeline.projectId}
            pages={pipeline.pages}
            {...(onOpenProject ? { onOpenWorkspace: onOpenProject } : {})}
          />
        ) : (
          <RulesStudio projectId={pipeline.projectId} />
        )}
      </section>
    );
  }

  return (
    <section className="zt-projects" aria-labelledby="zt-projects-title" data-testid="zero-two-projects-view">
      <header className="zt-projects__hero">
        <p className="zt-projects__kicker">Power BI</p>
        <h1 id="zt-projects-title" className="entry-section__title">
          Reports
        </h1>
        <p className="zt-projects__lede">
          Start a project by bringing an existing report in, or scaffolding a new one. Zero Two keeps every project under
          git so you can let the agent iterate safely.
        </p>
      </header>

      <div className="zt-projects__paths">
        {PATHS.map((path) => (
          <button
            key={path.id}
            type="button"
            className="zt-path-card-btn"
            onClick={() => (path.id === 'attach' ? setAttachOpen(true) : setNewOpen(true))}
            data-testid={`zt-path-${path.id}`}
          >
            <span className="zt-path-card-btn__icon">
              <Icon name={path.icon} size={20} />
            </span>
            <span className="zt-path-card-btn__title">{path.title}</span>
            <span className="zt-path-card-btn__desc">{path.description}</span>
            <span className="zt-path-card-btn__cta">
              {path.cta}
              <Icon name="chevron-right" size={14} />
            </span>
          </button>
        ))}
      </div>

      {onOpenDoctor ? (
        <button type="button" className="zt-projects__doctor-link" onClick={onOpenDoctor} data-testid="zt-open-doctor">
          <Icon name="blocks" size={14} />
          <span>Run an environment check</span>
        </button>
      ) : null}

      <AttachReportWizard
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onReportInventory={openPipeline}
      />
      <NewReportWizard
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onReportInventory={openPipeline}
      />
    </section>
  );
}
