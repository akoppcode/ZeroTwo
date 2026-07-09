// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZeroTwoProjectsView } from '../../src/components/ZeroTwoProjectsView';
import { NewReportWizard } from '../../src/components/NewReportWizard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ZeroTwoProjectsView', () => {
  it('opens the attach wizard on the Source step from the attach path card', () => {
    render(<ZeroTwoProjectsView />);
    fireEvent.click(screen.getByTestId('zt-path-attach'));
    expect(screen.getByTestId('attach-wizard')).toBeInTheDocument();
    expect(screen.getByTestId('attach-step-source')).toBeInTheDocument();
    // Start-watching stays disabled until a .pbix + destination are provided.
    expect(screen.getByTestId('attach-start-watch')).toBeDisabled();
  });

  it('surfaces the environment-check affordance when a handler is provided', () => {
    const onOpenDoctor = vi.fn();
    render(<ZeroTwoProjectsView onOpenDoctor={onOpenDoctor} />);
    fireEvent.click(screen.getByTestId('zt-open-doctor'));
    expect(onOpenDoctor).toHaveBeenCalledOnce();
  });

  it('lists saved projects from GET /api/projects/pbip and opens one on click', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects/pbip') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            projects: [
              {
                id: 'proj-a',
                name: 'Sales Review',
                kind: 'attached',
                agent: 'claude',
                pageCount: 3,
                visualCount: 12,
                hasSemanticModel: true,
                reportDirName: 'Sales.Report',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onOpenProject = vi.fn();

    render(<ZeroTwoProjectsView onOpenProject={onOpenProject} />);

    const card = await screen.findByTestId('zt-project-proj-a');
    expect(screen.getByTestId('zt-projects-list')).toBeInTheDocument();
    expect(card).toHaveTextContent('Sales Review');
    expect(card).toHaveTextContent('Attached');
    expect(card).toHaveTextContent('Claude Code');

    fireEvent.click(card);
    expect(onOpenProject).toHaveBeenCalledWith('proj-a');
  });

  it('shows the empty state when no projects are saved', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ projects: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ZeroTwoProjectsView />);

    expect(await screen.findByTestId('zt-projects-empty')).toBeInTheDocument();
    // Attach / New path cards remain available.
    expect(screen.getByTestId('zt-path-attach')).toBeInTheDocument();
    expect(screen.getByTestId('zt-path-new')).toBeInTheDocument();
  });
});

describe('NewReportWizard', () => {
  it('scaffolds via POST, provisions on the Ready step, then opens the new project', async () => {
    // Scaffold POST → 201; the Ready step then mounts ProvisioningPanel, which
    // checks agent auth (GET .../auth). Route by URL so both fetches resolve.
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/scaffold') {
        return Promise.resolve({ status: 201, json: async () => ({ project: { id: 'proj-123' } }) });
      }
      // /api/agents/claude/auth — signed in so provisioning is unblocked.
      return Promise.resolve({
        ok: true,
        json: async () => ({ agent: 'claude', loggedIn: true, user: 'ada@example.com', loginCommand: null }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onOpened = vi.fn();

    render(<NewReportWizard open onClose={() => {}} onOpened={onOpened} />);

    fireEvent.change(screen.getByTestId('new-name-input'), { target: { value: 'Q3 Review' } });
    fireEvent.change(screen.getByTestId('new-folder-input'), { target: { value: 'C:\\proj\\q3' } });
    fireEvent.click(screen.getByTestId('new-continue'));
    fireEvent.click(screen.getByTestId('new-create'));

    // Create advances to the Ready step and scaffolds with name/path/agent.
    await waitFor(() => expect(screen.getByTestId('new-step-ready')).toBeInTheDocument());
    const scaffoldCall = fetchMock.mock.calls.find((c) => c[0] === '/api/projects/scaffold')!;
    expect(JSON.parse((scaffoldCall[1] as RequestInit).body as string)).toMatchObject({
      name: 'Q3 Review',
      path: 'C:\\proj\\q3',
      agent: 'claude',
    });

    // Open workspace hands off the scaffolded project id.
    fireEvent.click(screen.getByTestId('new-open-workspace'));
    expect(onOpened).toHaveBeenCalledWith('proj-123');
  });
});
