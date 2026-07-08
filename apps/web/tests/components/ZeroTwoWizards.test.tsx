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
