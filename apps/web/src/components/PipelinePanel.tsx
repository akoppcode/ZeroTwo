// Pipeline host panel (design spec §6.2 + §7) — composes the stage stepper and
// the screenshot preview around a "Run pipeline" action. POSTs to
// `/api/projects/:id/pipeline/run` and reads the SSE stream, feeding
// `pipeline:stage` events into the stepper and `screenshots:updated` into the
// preview. Self-contained for now; the full Workspace surface (later phase)
// will host these two components directly.
//
// TODO(Workspace phase): lift Run/preview state into the Workspace shell and
// drop this standalone panel + its projects-view entry affordance.

import { useCallback, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { PipelineStepper } from './PipelineStepper';
import { PreviewPane } from './PreviewPane';
import {
  STAGE_ORDER,
  type PipelineDone,
  type ReportPage,
  type ScreenshotsPayload,
  type StageEvent,
  type StageName,
  type StageRemediation,
  type StageView,
} from './pipeline-types';

interface Props {
  projectId: string;
  pages: ReportPage[];
  /** Return to the projects list. */
  onClose?: () => void;
  /** Hand off to the full Workspace once it exists (later phase). */
  onOpenWorkspace?: (projectId: string) => void;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

const PENDING_STAGES: Record<StageName, StageView> = STAGE_ORDER.reduce(
  (acc, name) => ({ ...acc, [name]: { status: 'pending' } }),
  {} as Record<StageName, StageView>,
);

/**
 * Read the daemon SSE stream, invoking `onEvent` per `event:`/`data:` frame.
 * Copied from ProvisioningPanel / AttachReportWizard (same daemon framing).
 */
async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        try {
          onEvent(event, JSON.parse(dataLines.join('\n')) as Record<string, unknown>);
        } catch {
          // Ignore keepalive / non-JSON frames.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function PipelinePanel({ projectId, pages, onClose, onOpenWorkspace }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [started, setStarted] = useState(false);
  const [stages, setStages] = useState<Record<StageName, StageView>>(PENDING_STAGES);
  const [remediation, setRemediation] = useState<StageRemediation | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Displayed run = last `screenshots:updated`; active run = last `pipeline:start`.
  const [displayedRunId, setDisplayedRunId] = useState<string | null>(null);
  const [capturedPages, setCapturedPages] = useState<string[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const stale = displayedRunId != null && activeRunId !== displayedRunId;

  const run = useCallback(async () => {
    setPhase('running');
    setStarted(true);
    setStages(PENDING_STAGES);
    setRemediation(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/pipeline/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Pipeline could not start (HTTP ${res.status}).`);
      }
      let failed = false;
      await readSseStream(res.body, (event, data) => {
        if (event === 'pipeline:start') {
          setActiveRunId(typeof data.runId === 'string' ? data.runId : null);
        } else if (event === 'pipeline:stage') {
          const ev = data as unknown as StageEvent;
          setStages((prev) => ({
            ...prev,
            [ev.stage]: { status: ev.status, detail: ev.detail, attempt: ev.attempt },
          }));
        } else if (event === 'screenshots:updated') {
          const payload = data as unknown as ScreenshotsPayload;
          setDisplayedRunId(payload.runId);
          setCapturedPages(Array.isArray(payload.pages) ? payload.pages : []);
        } else if (event === 'pipeline:done') {
          const done = data as unknown as PipelineDone;
          if (done.remediation) setRemediation(done.remediation);
          if (done.screenshots) {
            setDisplayedRunId(done.screenshots.runId);
            setCapturedPages(done.screenshots.pages ?? []);
          }
          setPhase('done');
        } else if (event === 'pipeline:error') {
          failed = true;
          setError(typeof data.message === 'string' ? data.message : 'Pipeline failed.');
          setPhase('error');
        }
      });
      if (!failed) setPhase((prev) => (prev === 'running' ? 'done' : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pipeline failed.');
      setPhase('error');
    }
  }, [projectId]);

  const runLabel = useMemo(() => {
    if (phase === 'running') return 'Running…';
    return started ? 'Re-run pipeline' : 'Run pipeline';
  }, [phase, started]);

  return (
    <section className="zt-pipeline" aria-label="Pipeline" data-testid="pipeline-panel">
      <header className="zt-pipeline__head">
        <div className="zt-pipeline__head-copy">
          {onClose ? (
            <button type="button" className="zt-btn zt-btn--ghost" onClick={onClose} data-testid="pipeline-back">
              <Icon name="chevron-left" size={14} />
              <span>Back</span>
            </button>
          ) : null}
          <div>
            <p className="zt-projects__kicker">Pipeline</p>
            <h2 className="zt-pipeline__title">Preview &amp; commit</h2>
          </div>
        </div>
        <div className="zt-pipeline__head-actions">
          {onOpenWorkspace ? (
            <button
              type="button"
              className="zt-btn"
              onClick={() => onOpenWorkspace(projectId)}
              data-testid="pipeline-open-workspace"
            >
              <span>Open workspace</span>
            </button>
          ) : null}
          <button
            type="button"
            className="zt-btn zt-btn--primary"
            onClick={() => void run()}
            disabled={phase === 'running'}
            data-testid="pipeline-run"
          >
            <Icon name={phase === 'running' ? 'spinner' : 'play'} size={14} />
            <span>{runLabel}</span>
          </button>
        </div>
      </header>

      {started ? <PipelineStepper stages={stages} remediation={remediation} /> : null}

      {error ? (
        <div className="zt-notice zt-notice--error" role="alert" data-testid="pipeline-error">
          <Icon name="alert-triangle" size={16} />
          <div>
            <p className="zt-notice__title">Pipeline failed</p>
            <p className="zt-notice__text">{error}</p>
          </div>
        </div>
      ) : null}

      <PreviewPane
        projectId={projectId}
        pages={pages}
        runId={displayedRunId}
        capturedPages={capturedPages}
        stale={stale}
        refreshing={phase === 'running'}
        onRefresh={() => void run()}
      />
    </section>
  );
}
