// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZeroTwoWorkspace } from '../../src/components/ZeroTwoWorkspace';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PBIP_PAYLOAD = {
  project: {
    id: 'proj-1',
    name: 'Sales Report',
    kind: 'attached',
    agent: 'claude',
    path: 'C:/reports/Sales',
    reportDirName: 'Sales.Report',
    hasSemanticModel: true,
  },
  pages: [
    { name: 'Page1', displayName: 'Overview', hidden: false, width: 1280, height: 720, visuals: [] },
  ],
};

function stubFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/projects/proj-1/pbip') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PBIP_PAYLOAD) } as Response);
    }
    // Any other call (e.g. RulesStudio's inspect) returns an empty ruleset.
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('ZeroTwoWorkspace', () => {
  it('opens a PBIP project into the report surface, not the open-design sketch/design-system chrome', async () => {
    stubFetch();

    render(<ZeroTwoWorkspace projectId="proj-1" onBack={() => {}} />);

    // Report name in the header + a back-to-Reports affordance.
    expect(await screen.findByTestId('zerotwo-workspace-title')).toHaveTextContent('Sales Report');
    expect(screen.getByTestId('zerotwo-workspace-back')).toBeInTheDocument();

    // The report surface renders: pipeline preview with the page inventory.
    expect(screen.getByTestId('pipeline-panel')).toBeInTheDocument();
    expect(screen.getByTestId('preview-pane')).toBeInTheDocument();
    expect(screen.getByTestId('preview-tab-Page1')).toHaveTextContent('Overview');

    // The agent chat is present and pointed at the PBIP folder.
    expect(screen.getByTestId('zerotwo-chat-cwd')).toHaveTextContent('C:/reports/Sales');

    // None of the open-design (web-DESIGN) chrome leaks in.
    expect(screen.queryByText(/choose (a )?design system/i)).toBeNull();
    expect(screen.queryByText(/new sketch/i)).toBeNull();
    expect(screen.queryByTestId('file-workspace')).toBeNull();
  });

  it('switches to the Rules studio via the Preview|Rules subnav', async () => {
    stubFetch();

    render(<ZeroTwoWorkspace projectId="proj-1" onBack={() => {}} />);
    await screen.findByTestId('zerotwo-workspace-title');

    fireEvent.click(screen.getByTestId('zerotwo-workspace-tab-rules'));

    // Rules surface replaces the pipeline preview.
    await waitFor(() => expect(screen.queryByTestId('pipeline-panel')).toBeNull());
  });
});
