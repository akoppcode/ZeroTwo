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
  it('scaffolds via POST /api/projects/scaffold and reports the new project id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 201,
      json: async () => ({ project: { id: 'proj-123' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onOpened = vi.fn();

    render(<NewReportWizard open onClose={() => {}} onOpened={onOpened} />);

    fireEvent.change(screen.getByTestId('new-name-input'), { target: { value: 'Q3 Review' } });
    fireEvent.change(screen.getByTestId('new-folder-input'), { target: { value: 'C:\\proj\\q3' } });
    fireEvent.click(screen.getByTestId('new-continue'));
    fireEvent.click(screen.getByTestId('new-create'));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('proj-123'));
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/projects/scaffold');
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({
      name: 'Q3 Review',
      path: 'C:\\proj\\q3',
      agent: 'claude',
    });
  });
});
