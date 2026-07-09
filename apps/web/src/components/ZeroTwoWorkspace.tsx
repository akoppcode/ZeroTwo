// Zero Two report workspace — the surface a PBIP project opens into (replacing
// the inherited open-design ProjectView, which is a web-DESIGN tool). Left: the
// agent chat pointed at the PBIP folder. Right: the report surface — the
// pipeline preview (page screenshots + comment mode) and the Rules studio, on a
// Preview|Rules subnav. No sketches / decks / design systems / browser.
//
// Detection lives in App: a PBIP project id resolves via GET /api/projects/:id/
// pbip (which 404s for inherited projects); this component then fetches that
// same endpoint for its live page inventory + project fields.

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { PipelinePanel } from './PipelinePanel';
import { RulesStudio } from './RulesStudio';
import { ZeroTwoChatPane } from './ZeroTwoChatPane';
import type { ReportPage } from './pipeline-types';

interface PbipProject {
  id: string;
  name: string;
  kind: string;
  agent: string;
  path: string;
  reportDirName: string | null;
  hasSemanticModel: boolean;
}

interface Props {
  projectId: string;
  /** Return to the Reports home. */
  onBack: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; project: PbipProject; pages: ReportPage[] };

export function ZeroTwoWorkspace({ projectId, onBack }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [tab, setTab] = useState<'pipeline' | 'rules'>('pipeline');
  // Prompt handed from comment mode to the chat composer (one-shot).
  const [injectedPrompt, setInjectedPrompt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/pbip`);
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', message: 'This report could not be opened.' });
          return;
        }
        const body = (await res.json()) as { project: PbipProject; pages?: ReportPage[] };
        if (!cancelled) setState({ status: 'ready', project: body.project, pages: body.pages ?? [] });
      } catch {
        if (!cancelled) setState({ status: 'error', message: 'This report could not be opened.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleSubmitPrompt = useCallback((prompt: string) => {
    setInjectedPrompt(prompt);
  }, []);

  const backButton = (
    <button type="button" className="zt-btn zt-btn--ghost" onClick={onBack} data-testid="zerotwo-workspace-back">
      <Icon name="chevron-left" size={14} />
      <span>Reports</span>
    </button>
  );

  if (state.status !== 'ready') {
    return (
      <section className="zt-workspace" aria-label="Report workspace" data-testid="zerotwo-workspace">
        <header className="zt-workspace__head">{backButton}</header>
        <div className="zt-workspace__status" role="status" data-testid="zerotwo-workspace-status">
          {state.status === 'loading' ? (
            <>
              <Icon name="spinner" size={18} />
              <p>Opening report…</p>
            </>
          ) : (
            <>
              <Icon name="alert-triangle" size={18} />
              <p>{state.message}</p>
            </>
          )}
        </div>
      </section>
    );
  }

  const { project, pages } = state;

  return (
    <section className="zt-workspace" aria-label="Report workspace" data-testid="zerotwo-workspace">
      <header className="zt-workspace__head">
        {backButton}
        <div className="zt-workspace__title-group">
          <p className="zt-projects__kicker">Power BI report</p>
          <h1 className="zt-workspace__title" data-testid="zerotwo-workspace-title">
            {project.name}
          </h1>
        </div>
        <div className="zt-rules__mode" role="tablist" aria-label="Report surface">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pipeline'}
            className={`zt-rules__mode-btn${tab === 'pipeline' ? ' is-active' : ''}`}
            onClick={() => setTab('pipeline')}
            data-testid="zerotwo-workspace-tab-pipeline"
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rules'}
            className={`zt-rules__mode-btn${tab === 'rules' ? ' is-active' : ''}`}
            onClick={() => setTab('rules')}
            data-testid="zerotwo-workspace-tab-rules"
          >
            Rules
          </button>
        </div>
      </header>

      <div className="zt-workspace__body">
        <div className="zt-workspace__chat">
          <ZeroTwoChatPane
            projectId={project.id}
            agent={project.agent}
            workingDir={project.path}
            injectedPrompt={injectedPrompt}
            onInjectedPromptConsumed={() => setInjectedPrompt(null)}
          />
        </div>
        <div className="zt-workspace__surface">
          {tab === 'pipeline' ? (
            <PipelinePanel projectId={project.id} pages={pages} onSubmitPrompt={handleSubmitPrompt} />
          ) : (
            <RulesStudio projectId={project.id} onAskAgent={handleSubmitPrompt} />
          )}
        </div>
      </div>
    </section>
  );
}
