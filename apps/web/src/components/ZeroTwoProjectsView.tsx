// Zero Two projects home (design spec §3.1) — the entry surface for the Phase 2
// wizards. Renders the two primary paths (Attach a report / New report) and
// hosts both wizard modals. Wired into the entry shell the same rail/route way
// as DoctorView.

import { useCallback, useEffect, useState } from 'react';
import { AttachReportWizard } from './AttachReportWizard';
import { Icon, type IconName } from './Icon';
import { NewReportWizard } from './NewReportWizard';
import { PipelinePanel } from './PipelinePanel';
import { RulesStudio } from './RulesStudio';
import type { ReportPage } from './pipeline-types';

/** A saved PBIP project as returned by `GET /api/projects/pbip` (newest first). */
interface SavedProject {
  id: string;
  name: string;
  kind: string;
  agent: string;
  pageCount: number;
  visualCount: number;
  hasSemanticModel: boolean;
  reportDirName: string;
  createdAt: string;
  updatedAt: string;
}

const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', copilot: 'Copilot' };

function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

/** Compact "updated N ago" string; falls back to the raw value if unparseable. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const units: Array<[label: string, secs: number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [label, secs] of units) {
    const value = Math.floor(seconds / secs);
    if (value >= 1) return `${value} ${label}${value === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

interface Props {
  /** Switch to the Doctor route (tertiary "environment check" affordance). */
  onOpenDoctor?: () => void;
  /** Open the workspace for a freshly attached / scaffolded project. */
  onOpenProject?: (projectId: string) => void;
  /** When true, open the New report wizard (driven by the entry rail's "+"). */
  openNewReport?: boolean;
  /** Called once an `openNewReport` request has been consumed. */
  onNewReportHandled?: () => void;
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

export function ZeroTwoProjectsView({ onOpenDoctor, onOpenProject, openNewReport, onNewReportHandled }: Props) {
  const [attachOpen, setAttachOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // Phase 4: once a project is attached / scaffolded, open its pipeline preview
  // inline. Phase 6 adds a Rules surface for the same project.
  // TODO(Workspace phase): the Workspace shell will own this Preview/Rules nav
  // and the project/session context — this inline toggle is a stopgap.
  const [pipeline, setPipeline] = useState<{ projectId: string; pages: ReportPage[] } | null>(null);
  const [projectTab, setProjectTab] = useState<'pipeline' | 'rules'>('pipeline');
  // Saved projects (null = not yet loaded, so we don't flash the empty state).
  const [projects, setProjects] = useState<SavedProject[] | null>(null);

  // Load the saved-project list. Called on mount and again whenever a wizard
  // reports success so a freshly attached / scaffolded project shows up.
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects/pbip');
      if (!res.ok) {
        setProjects((prev) => prev ?? []);
        return;
      }
      const body = (await res.json()) as { projects?: SavedProject[] };
      setProjects(body.projects ?? []);
    } catch {
      setProjects((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // The entry rail's "+" requests the New report wizard by flipping
  // `openNewReport`. Consume it once, clearing any inline pipeline preview so
  // the wizard is actually visible, then notify the parent to reset the flag.
  useEffect(() => {
    if (!openNewReport) return;
    setPipeline(null);
    setNewOpen(true);
    onNewReportHandled?.();
  }, [openNewReport, onNewReportHandled]);

  const openPipeline = (projectId: string, pages: ReportPage[]) => {
    setAttachOpen(false);
    setNewOpen(false);
    setProjectTab('pipeline');
    setPipeline({ projectId, pages });
    // A wizard just succeeded — refresh so the new project is listed on return.
    void loadProjects();
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

      {projects !== null ? (
        <section className="zt-projects__saved" aria-labelledby="zt-projects-saved-title" data-testid="zt-projects-list">
          <h2 id="zt-projects-saved-title" className="zt-projects__saved-title">
            Your projects
          </h2>
          {projects.length === 0 ? (
            <p className="zt-projects__empty" data-testid="zt-projects-empty">
              No projects yet — attach or create one below.
            </p>
          ) : (
            <ul className="zt-projects__grid">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className="zt-project-card"
                    onClick={() => onOpenProject?.(project.id)}
                    data-testid={`zt-project-${project.id}`}
                  >
                    <span className="zt-project-card__head">
                      <span className="zt-project-card__name">{project.name}</span>
                      <span className={`zt-project-card__badge zt-project-card__badge--${project.kind}`}>
                        {project.kind === 'scaffolded' ? 'Scaffolded' : 'Attached'}
                      </span>
                    </span>
                    <span className="zt-project-card__meta">
                      <span className="zt-project-card__agent">{agentLabel(project.agent)}</span>
                      <span>
                        {project.pageCount} page{project.pageCount === 1 ? '' : 's'} · {project.visualCount} visual
                        {project.visualCount === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="zt-project-card__updated">Updated {relativeTime(project.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

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
