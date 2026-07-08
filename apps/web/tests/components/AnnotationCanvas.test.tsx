// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotationCanvas, type Annotation } from '../../src/components/AnnotationCanvas';
import type { ReportPage } from '../../src/components/pipeline-types';

const PAGE: ReportPage = {
  name: 'Page1',
  displayName: 'Overview',
  hidden: false,
  width: 1280,
  height: 720,
  visuals: [
    { id: 'v-rev', visualType: 'barChart', title: 'Revenue by Region' },
    { id: 'v-kpi', visualType: 'card', title: 'Total Sales' },
  ],
};

function annotation(over: Partial<Annotation>): Annotation {
  return {
    id: 'a1',
    sessionId: 'sess-1',
    pageName: 'Page1',
    kind: 'pin',
    x: 640,
    y: 360,
    w: null,
    h: null,
    canvasX: 640,
    canvasY: 360,
    canvasW: null,
    canvasH: null,
    text: '',
    visualId: 'v-rev',
    visualType: 'barChart',
    visualTitle: 'Revenue by Region',
    matchKind: 'contains',
    status: 'draft',
    ...over,
  };
}

/** Records every fetch and dispatches canned responses by URL + method. */
function installFetch(existing: Annotation[]) {
  const calls: { url: string; method: string; body: any }[] = [];
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.startsWith('/api/annotations?')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ annotations: existing }) });
    }
    if (url.endsWith('/annotations') && method === 'POST') {
      const created = annotation({ id: 'new-1', ...body, visualTitle: 'Revenue by Region', matchKind: 'contains' });
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ annotation: created }) });
    }
    if (method === 'PATCH') {
      const target = existing.find((a) => url.endsWith(a.id)) ?? existing[0]!;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ annotation: { ...target, ...body, matchKind: body.visualId ? 'manual' : target.matchKind } }),
      });
    }
    if (url.endsWith('/annotations/submit') && method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ blocks: [{ pageName: 'Page1', prompt: 'On page "Overview": pin @ Revenue by Region — fix the axis.' }] }),
      });
    }
    if (method === 'DELETE') {
      return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

beforeEach(() => {
  // jsdom lacks pointer capture; stub to no-ops so the gesture handlers run.
  (HTMLElement.prototype as any).setPointerCapture = vi.fn();
  (HTMLElement.prototype as any).releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const baseProps = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  page: PAGE,
  runId: 'run-1',
  screenshotUrl: '/api/projects/proj-1/screenshots/run-1/Page1.png',
};

describe('AnnotationCanvas', () => {
  it('loads the session annotations on mount and renders markers + list with the matched visual', async () => {
    installFetch([
      annotation({ id: 'a1', kind: 'pin', visualTitle: 'Revenue by Region' }),
      annotation({ id: 'a2', kind: 'rect', canvasW: 200, canvasH: 100, w: 200, h: 100, visualTitle: 'Total Sales', visualId: 'v-kpi' }),
    ]);

    render(<AnnotationCanvas {...baseProps} />);

    await waitFor(() => expect(screen.getByTestId('annotation-marker-a1')).toBeInTheDocument());
    expect(screen.getByTestId('annotation-marker-a2')).toBeInTheDocument();

    const list = screen.getByTestId('annotation-list');
    // Text appears on both the match chip and the visual-correction dropdown.
    expect(within(list).getAllByText('Revenue by Region').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('Total Sales').length).toBeGreaterThan(0);
  });

  it('drops a pin: POSTs computed canvas coords and renders a marker with the returned matched visual', async () => {
    const { calls } = installFetch([]);

    // Give the overlay a known box and the image real natural dimensions so the
    // px -> canvas-unit mapping is deterministic in jsdom.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, value: 1280 });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, value: 720 });

    render(<AnnotationCanvas {...baseProps} />);
    const overlay = await screen.findByTestId('annotation-overlay');

    fireEvent.pointerDown(overlay, { clientX: 640, clientY: 360, button: 0, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 640, clientY: 360, button: 0, pointerId: 1 });

    await waitFor(() => expect(screen.getByTestId('annotation-marker-new-1')).toBeInTheDocument());

    const post = calls.find((c) => c.url.endsWith('/annotations') && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post!.body.kind).toBe('pin');
    // Click at the centre of a 1280x720 box -> canvas (640, 360).
    expect(post!.body.canvasX).toBeCloseTo(640, 3);
    expect(post!.body.canvasY).toBeCloseTo(360, 3);
    expect(post!.body.pageName).toBe('Page1');

    // The daemon-returned matched visual is surfaced on the marker + list.
    expect(within(screen.getByTestId('annotation-list')).getAllByText('Revenue by Region').length).toBeGreaterThan(0);
  });

  it('edits annotation text via PATCH', async () => {
    const { calls } = installFetch([annotation({ id: 'a1', text: '' })]);
    render(<AnnotationCanvas {...baseProps} />);

    fireEvent.click(await screen.findByTestId('annotation-text-a1'));
    const input = screen.getByTestId('annotation-text-input-a1');
    fireEvent.change(input, { target: { value: 'Make this a line chart' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch!.url).toBe('/api/annotations/a1');
      expect(patch!.body.text).toBe('Make this a line chart');
    });
  });

  it('corrects the matched visual via the dropdown (PATCH visualId)', async () => {
    const { calls } = installFetch([annotation({ id: 'a1', visualId: 'v-rev' })]);
    render(<AnnotationCanvas {...baseProps} />);

    const select = await screen.findByTestId('annotation-visual-select-a1');
    fireEvent.change(select, { target: { value: 'v-kpi' } });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch!.body.visualId).toBe('v-kpi');
      expect(patch!.body.visualTitle).toBe('Total Sales');
    });
  });

  it('sends to agent: POSTs submit and shows the returned prompt (and calls onSubmitPrompt)', async () => {
    const onSubmitPrompt = vi.fn();
    const { calls } = installFetch([annotation({ id: 'a1', status: 'draft' })]);
    render(<AnnotationCanvas {...baseProps} onSubmitPrompt={onSubmitPrompt} />);

    fireEvent.click(await screen.findByTestId('annotation-submit'));

    const promptPanel = await screen.findByTestId('annotation-prompt');
    expect(promptPanel).toHaveTextContent('fix the axis');

    const submit = calls.find((c) => c.url.endsWith('/annotations/submit') && c.method === 'POST');
    expect(submit).toBeTruthy();
    expect(submit!.body.sessionId).toBe('sess-1');
    expect(onSubmitPrompt).toHaveBeenCalledWith(expect.stringContaining('fix the axis'));
  });

  it('deletes an annotation via DELETE', async () => {
    const { calls } = installFetch([annotation({ id: 'a1' })]);
    render(<AnnotationCanvas {...baseProps} />);

    fireEvent.click(await screen.findByTestId('annotation-delete-a1'));

    await waitFor(() => expect(screen.queryByTestId('annotation-marker-a1')).not.toBeInTheDocument());
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del!.url).toBe('/api/annotations/a1');
  });
});

// NOTE: jsdom has no real layout engine, so the pointer-coordinate mapping test
// stubs getBoundingClientRect + naturalWidth/Height to feed deterministic
// geometry. The full drag-to-rectangle gesture (pointermove past the drag
// threshold) is exercised by the app at runtime rather than simulated here.
