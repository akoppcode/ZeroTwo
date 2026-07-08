// @vitest-environment jsdom

// Phase 1 Doctor — DoctorView jsdom smoke.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DoctorReport } from '@open-design/contracts';
import { DoctorView } from '../../src/components/DoctorView';

const REPORT: DoctorReport = {
  overall: 'warning',
  generatedAt: '2026-07-08T00:00:00.000Z',
  checks: [
    {
      id: 'node',
      label: 'Node.js',
      status: 'ok',
      detected: 'v20.11.0',
      remediation: null,
      commands: [],
      hard: true,
    },
    {
      id: 'powerbi-desktop',
      label: 'Power BI Desktop',
      status: 'warning',
      detected: '2.150.0.0',
      remediation: 'Update Power BI Desktop to the latest version.',
      commands: [
        { label: 'Install the bridge CLI', command: 'npm install -g @microsoft/pbi-bridge' },
      ],
      hard: false,
    },
    {
      id: 'agents',
      label: 'Agents signed in',
      status: 'error',
      detected: null,
      remediation: 'Sign in to at least one coding agent.',
      commands: [],
      hard: true,
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url) => {
    if (url === '/api/doctor') {
      return new Response(JSON.stringify(REPORT), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DoctorView', () => {
  it('fetches /api/doctor and renders one row per check with its status and detected value', async () => {
    render(<DoctorView />);

    await waitFor(() => screen.getByTestId('doctor-list'));

    expect(fetchMock).toHaveBeenCalledWith('/api/doctor');

    // One row per check, in the order returned.
    const rows = screen.getAllByTestId(/^doctor-row-/);
    expect(rows.map((row) => row.getAttribute('data-check-id'))).toEqual([
      'node',
      'powerbi-desktop',
      'agents',
    ]);

    // Per-row status is exposed via data-status.
    expect(screen.getByTestId('doctor-row-node').getAttribute('data-status')).toBe('ok');
    expect(screen.getByTestId('doctor-row-powerbi-desktop').getAttribute('data-status')).toBe(
      'warning',
    );
    expect(screen.getByTestId('doctor-row-agents').getAttribute('data-status')).toBe('error');

    // Detected value, and the "—" fallback for a null detected value.
    expect(screen.getByTestId('doctor-detected-node').textContent).toBe('v20.11.0');
    expect(screen.getByTestId('doctor-detected-agents').textContent).toBe('—');

    // Overall pill reflects the worst status.
    expect(screen.getByTestId('doctor-overall').textContent).toContain('Warning');

    // Remediation + copyable command render for the failing row only.
    expect(screen.getByText('Update Power BI Desktop to the latest version.')).toBeTruthy();
    expect(screen.getByText('npm install -g @microsoft/pbi-bridge')).toBeTruthy();
  });

  it('re-fetches when the Re-check button is pressed', async () => {
    render(<DoctorView />);

    await waitFor(() => screen.getByTestId('doctor-list'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    screen.getByTestId('doctor-recheck').click();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/doctor');
  });
});
