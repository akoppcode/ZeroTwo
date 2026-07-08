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
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/projects/proj-1/pipeline/run');
      expect(init?.method).toBe('POST');
      return Promise.resolve(sseResponse(frames));
    });
    vi.stubGlobal('fetch', fetchMock);

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
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse(frames)));
    vi.stubGlobal('fetch', fetchMock);

    render(<PipelinePanel projectId="proj-1" pages={PAGES} />);
    fireEvent.click(screen.getByTestId('pipeline-run'));

    const banner = await screen.findByTestId('stepper-remediation');
    expect(banner).toHaveTextContent('Reload failed');
    expect(banner).toHaveTextContent('Open the report in Power BI Desktop');
    expect(screen.getByTestId('stepper-remediation-detail')).toHaveTextContent('bridge timeout after 30s');
    expect(screen.getByTestId('stepper-stage-reload')).toHaveAttribute('data-status', 'failed');
  });
});
