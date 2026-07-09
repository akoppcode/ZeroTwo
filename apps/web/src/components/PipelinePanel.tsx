// Pipeline host panel (design spec §6.2 + §7) — composes the stage stepper and
// the screenshot preview around a "Run pipeline" action. POSTs to
// `/api/projects/:id/pipeline/run` and reads the SSE stream, feeding
// `pipeline:stage` events into the stepper and `screenshots:updated` into the
// preview. Self-contained for now; the full Workspace surface (later phase)
// will host these two components directly.
//
// TODO(Workspace phase): lift Run/preview state into the Workspace shell and
// drop this standalone panel + its projects-view entry affordance.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from '../utils/uuid';
import { Icon } from './Icon';
import { PipelineStepper } from './PipelineStepper';
import { PreviewPane } from './PreviewPane';
import {
  STAGE_ORDER,
  type PipelineDone,
  type PipelineLatest,
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
  /** Sink for a comment-mode annotation prompt (Workspace pipes it into the chat). */
  onSubmitPrompt?: (prompt: string) => void;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

const PENDING_STAGES: Record<StageName, StageView> = STAGE_ORDER.reduce(
  (acc, name) => ({ ...acc, [name]: { status: 'pending' } }),
  {} as Record<StageName, StageView>,
);

/** Poll interval (ms) for restoring an in-progress run that started before this
 *  panel mounted (or while it was unmounted during navigation). */
const LATEST_POLL_MS = 1500;

/** Replay a run's ordered stage events into the stepper's per-stage view. */
function stagesToView(events: StageEvent[]): Record<StageName, StageView> {
  const view: Record<StageName, StageView> = { ...PENDING_STAGES };
  for (const ev of events) {
    view[ev.stage] = { status: ev.status, detail: ev.detail, attempt: ev.attempt };
  }
  return view;
}

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

export function PipelinePanel({ projectId, pages, onClose, onOpenWorkspace, onSubmitPrompt }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [started, setStarted] = useState(false);
  const [stages, setStages] = useState<Record<StageName, StageView>>(PENDING_STAGES);
  const [remediation, setRemediation] = useState<StageRemediation | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Displayed run = last `screenshots:updated`; active run = last `pipeline:start`.
  const [displayedRunId, setDisplayedRunId] = useState<string | null>(null);
  const [capturedPages, setCapturedPages] = useState<string[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Stable comment-mode session id for this project view (spec §9).
  // TODO(chat phase): tie this to the real agent session id instead of minting one.
  const sessionId = useMemo(() => randomUUID(), []);

  const stale = displayedRunId != null && activeRunId !== displayedRunId;

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Hydrate the stepper + preview from a stored run (restore after unmount) and
  // report whether the run is still in progress (so the caller keeps polling).
  const applyLatest = useCallback((latest: PipelineLatest): boolean => {
    if (latest.status !== 'running' && latest.status !== 'done') return false;
    setStarted(true);
    setStages(stagesToView(latest.stages ?? []));
    setActiveRunId(latest.runId);
    if (latest.screenshots) {
      setDisplayedRunId(latest.screenshots.runId);
      setCapturedPages(latest.screenshots.pages ?? []);
    }
    if (latest.status === 'running') {
      setRemediation(null);
      setPhase('running');
      return true;
    }
    setRemediation(latest.remediation ?? null);
    setPhase('done');
    return false;
  }, []);

  // On mount / project change: restore the latest run, and if it is still
  // running, poll until it completes. A fresh "Run pipeline" click supersedes
  // this via the live SSE stream (which stops the poll).
  useEffect(() => {
    let cancelled = false;
    stopPolling();
    setPhase('idle');
    setStarted(false);
    setStages(PENDING_STAGES);
    setRemediation(null);
    setError(null);
    setDisplayedRunId(null);
    setCapturedPages([]);
    setActiveRunId(null);

    const fetchLatest = async (): Promise<PipelineLatest | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/pipeline/latest`);
        if (!res.ok) return null;
        return (await res.json()) as PipelineLatest;
      } catch {
        return null;
      }
    };

    void (async () => {
      const latest = await fetchLatest();
      if (cancelled || !latest) return;
      const running = applyLatest(latest);
      if (!running) return;
      pollRef.current = setInterval(async () => {
        const next = await fetchLatest();
        if (cancelled || !next) return;
        if (!applyLatest(next)) stopPolling();
      }, LATEST_POLL_MS);
    })();

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [projectId, applyLatest, stopPolling]);

  const run = useCallback(async () => {
    stopPolling();
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
  }, [projectId, stopPolling]);

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
        sessionId={sessionId}
        {...(onSubmitPrompt ? { onSubmitPrompt } : {})}
      />
    </section>
  );
}
