// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PipelinePanel } from '../../src/components/PipelinePanel';
import { PipelineStepper } from '../../src/components/PipelineStepper';
import type { ReportPage, StageName, StageView } from '../../src/components/pipeline-types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Build a Response-like object whose body is a web ReadableStream of SSE frames. */
function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

/**
 * URL-aware fetch mock: the panel restores from `…/pipeline/latest` on mount and
 * streams a fresh run from `…/pipeline/run`. `latest` defaults to "no prior run".
 */
function routeFetch(runFrames: string[], latest: unknown = { status: 'none' }) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/pipeline/latest')) return Promise.resolve(jsonResponse(latest));
    if (url.endsWith('/pipeline/run')) {
      expect(init?.method).toBe('POST');
      return Promise.resolve(sseResponse(runFrames));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function page(name: string, displayName: string, hidden = false): ReportPage {
  return { name, displayName, hidden, width: 1280, height: 720, visuals: [] };
}

const PAGES: ReportPage[] = [page('Page1', 'Overview'), page('Page2', 'Details', true)];

describe('PipelineStepper', () => {
  it('renders the five stages from props and surfaces a remediation banner', () => {
    const stages: Record<StageName, StageView> = {
      validate: { status: 'passed', attempt: 2 },
      inspect: { status: 'passed' },
      reload: { status: 'failed', detail: 'bridge not connected' },
      screenshot: { status: 'pending' },
      commit: { status: 'pending' },
    };
    render(
      <PipelineStepper
        stages={stages}
        remediation={{ stage: 'reload', message: 'Open the report in Power BI Desktop, then retry.' }}
      />,
    );

    for (const stage of ['validate', 'inspect', 'reload', 'screenshot', 'commit']) {
      expect(screen.getByTestId(`stepper-stage-${stage}`)).toBeInTheDocument();
    }
    // validate surfaces its retry attempt count.
    expect(screen.getByTestId('stepper-attempt-validate')).toHaveTextContent('attempt 2');
    // failed reload renders the Doctor-style remediation banner + detail.
    const banner = screen.getByTestId('stepper-remediation');
    expect(banner).toHaveTextContent('Reload failed');
    expect(banner).toHaveTextContent('Open the report in Power BI Desktop');
    expect(screen.getByTestId('stepper-remediation-detail')).toHaveTextContent('bridge not connected');
  });
});

describe('PipelinePanel', () => {
  it('runs the pipeline over SSE: stepper progresses and the preview renders a page tab + img', async () => {
    const frames = [
      'event:pipeline:start\ndata:{"runId":"run-1"}\n\n',
      'event:pipeline:stage\ndata:{"stage":"validate","status":"passed","attempt":1}\n\n',
      'event:pipeline:stage\ndata:{"stage":"inspect","status":"passed"}\n\n',
      'event:pipeline:stage\ndata:{"stage":"reload","status":"passed"}\n\n',
      'event:pipeline:stage\ndata:{"stage":"screenshot","status":"passed","detail":"1 page(s)"}\n\n',
      'event:screenshots:updated\ndata:{"runId":"run-1","pages":["Page1"]}\n\n',
      'event:pipeline:stage\ndata:{"stage":"commit","status":"passed"}\n\n',
      'event:pipeline:done\ndata:{"ok":true,"stages":[],"screenshots":{"runId":"run-1","pages":["Page1"]}}\n\n',
    ];
    vi.stubGlobal('fetch', routeFetch(frames));

    render(<PipelinePanel projectId="proj-1" pages={PAGES} />);

    // Page tabs render from the inventory before any run (order + hidden chip).
    const overviewTab = screen.getByTestId('preview-tab-Page1');
    expect(overviewTab).toHaveTextContent('Overview');
    expect(within(screen.getByTestId('preview-tab-Page2')).getByText('hidden')).toBeInTheDocument();
    // No screenshot yet.
    expect(screen.getByTestId('preview-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pipeline-run'));

    // Stepper appears and stages settle to passed.
    await waitFor(() =>
      expect(screen.getByTestId('stepper-stage-commit')).toHaveAttribute('data-status', 'passed'),
    );
    expect(screen.getByTestId('stepper-stage-validate')).toHaveAttribute('data-status', 'passed');

    // Preview now renders the captured PNG for the active page.
    const img = await screen.findByTestId('preview-img');
    expect(img).toHaveAttribute('src', '/api/projects/proj-1/screenshots/run-1/Page1.png');
  });

  it('shows the remediation banner when a stage fails', async () => {
    const frames = [
      'event:pipeline:start\ndata:{"runId":"run-2"}\n\n',
      'event:pipeline:stage\ndata:{"stage":"validate","status":"passed","attempt":1}\n\n',
      'event:pipeline:stage\ndata:{"stage":"inspect","status":"passed"}\n\n',
      'event:pipeline:stage\ndata:{"stage":"reload","status":"failed","detail":"bridge timeout after 30s"}\n\n',
      'event:pipeline:done\ndata:{"ok":false,"stages":[],"remediation":{"stage":"reload","message":"Open the report in Power BI Desktop, then retry."}}\n\n',
    ];
    vi.stubGlobal('fetch', routeFetch(frames));

    render(<PipelinePanel projectId="proj-1" pages={PAGES} />);
    fireEvent.click(screen.getByTestId('pipeline-run'));

    const banner = await screen.findByTestId('stepper-remediation');
    expect(banner).toHaveTextContent('Reload failed');
    expect(banner).toHaveTextContent('Open the report in Power BI Desktop');
    expect(screen.getByTestId('stepper-remediation-detail')).toHaveTextContent('bridge timeout after 30s');
    expect(screen.getByTestId('stepper-stage-reload')).toHaveAttribute('data-status', 'failed');
  });

  it('restores a completed run from …/pipeline/latest on mount (survives navigation)', async () => {
    const latest = {
      runId: 'run-9',
      status: 'done',
      ok: true,
      stages: [
        { stage: 'validate', status: 'passed', attempt: 1 },
        { stage: 'inspect', status: 'passed' },
        { stage: 'reload', status: 'passed' },
        { stage: 'screenshot', status: 'passed', detail: '1 page(s)' },
        { stage: 'commit', status: 'passed' },
      ],
      screenshots: { runId: 'run-9', pages: ['Page1'] },
      startedAt: 1,
      finishedAt: 2,
    };
    // No run is triggered — the panel hydrates purely from the stored run.
    vi.stubGlobal('fetch', routeFetch([], latest));

    render(<PipelinePanel projectId="proj-1" pages={PAGES} />);

    // The stepper appears (started) and reflects the stored stages…
    await waitFor(() =>
      expect(screen.getByTestId('stepper-stage-commit')).toHaveAttribute('data-status', 'passed'),
    );
    expect(screen.getByTestId('stepper-stage-validate')).toHaveAttribute('data-status', 'passed');
    // …and the captured preview is restored without re-running.
    const img = await screen.findByTestId('preview-img');
    expect(img).toHaveAttribute('src', '/api/projects/proj-1/screenshots/run-9/Page1.png');
  });

  it('reconnects to a running restored run by polling …/pipeline/latest until done', async () => {
    const running = {
      runId: 'run-7',
      status: 'running',
      stages: [{ stage: 'validate', status: 'running', attempt: 1 }],
      startedAt: 1,
    };
    const done = {
      runId: 'run-7',
      status: 'done',
      ok: true,
      stages: [
        { stage: 'validate', status: 'passed', attempt: 1 },
        { stage: 'inspect', status: 'passed' },
        { stage: 'reload', status: 'passed' },
        { stage: 'screenshot', status: 'passed', detail: '1 page(s)' },
        { stage: 'commit', status: 'passed' },
      ],
      screenshots: { runId: 'run-7', pages: ['Page1'] },
      startedAt: 1,
      finishedAt: 2,
    };
    let calls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/pipeline/latest')) {
        calls += 1;
        return Promise.resolve(jsonResponse(calls === 1 ? running : done));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PipelinePanel projectId="proj-1" pages={PAGES} />);

    // Restored as in-progress: validate is running.
    await waitFor(() =>
      expect(screen.getByTestId('stepper-stage-validate')).toHaveAttribute('data-status', 'running'),
    );

    // A subsequent poll observes completion and settles the stepper + preview.
    await waitFor(
      () => expect(screen.getByTestId('stepper-stage-commit')).toHaveAttribute('data-status', 'passed'),
      { timeout: 4000 },
    );
    const img = await screen.findByTestId('preview-img');
    expect(img).toHaveAttribute('src', '/api/projects/proj-1/screenshots/run-7/Page1.png');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
