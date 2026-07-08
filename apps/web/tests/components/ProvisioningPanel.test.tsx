// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProvisioningPanel } from '../../src/components/ProvisioningPanel';

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

const SIGNED_OUT = {
  ok: true,
  json: async () => ({ agent: 'claude', loggedIn: false, user: null, loginCommand: 'claude /login' }),
};

const SIGNED_IN = {
  ok: true,
  json: async () => ({ agent: 'claude', loggedIn: true, user: 'ada@example.com', loginCommand: null }),
};

describe('ProvisioningPanel', () => {
  it('shows the login command and blocks provisioning when signed out', async () => {
    const fetchMock = vi.fn().mockResolvedValue(SIGNED_OUT);
    vi.stubGlobal('fetch', fetchMock);

    render(<ProvisioningPanel agent="claude" projectPath="C:\\proj\\q3" />);

    await waitFor(() => expect(screen.getByTestId('prov-signed-out')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/claude/auth');
    // The CLI login command is surfaced in the copyable chip.
    expect(screen.getByText('claude /login')).toBeInTheDocument();
    // Provisioning is not offered until the user signs in.
    expect(screen.queryByTestId('prov-provision')).not.toBeInTheDocument();
  });

  it('provisions over SSE and renders the verified report when signed in', async () => {
    const provisionFrames = [
      'event:start\ndata:{"agent":"claude"}\n\n',
      'event:step\ndata:{"command":"/plugin marketplace add microsoft/skills-for-fabric","ok":true,"output":"added"}\n\n',
      'event:step\ndata:{"command":"/plugin install powerbi-authoring@fabric-collection","ok":true,"output":"installed"}\n\n',
      'event:report\ndata:{"agent":"claude","steps":[],"installed":[{"ref":"powerbi-authoring","version":"1.2.0"}],"missing":[],"verified":true,"zeroTwoMdPath":"C:\\\\proj\\\\q3\\\\ZERO_TWO.md"}\n\n',
      'event:done\ndata:{"verified":true}\n\n',
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/agents/provision') {
        expect(init?.method).toBe('POST');
        return Promise.resolve(sseResponse(provisionFrames));
      }
      return Promise.resolve(SIGNED_IN);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ProvisioningPanel agent="claude" projectPath={'C:\\proj\\q3'} />);

    // Signed-in account surfaces and the provision button appears.
    await waitFor(() => expect(screen.getByTestId('prov-signed-in')).toBeInTheDocument());
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('prov-provision'));

    // POST fired with agent + projectPath.
    const provisionCall = await waitFor(() =>
      fetchMock.mock.calls.find((c) => c[0] === '/api/agents/provision'),
    );
    expect(JSON.parse((provisionCall![1] as RequestInit).body as string)).toEqual({
      agent: 'claude',
      projectPath: 'C:\\proj\\q3',
    });

    // Live step rows appear in order.
    await waitFor(() => expect(screen.getAllByTestId('prov-step')).toHaveLength(2));
    expect(screen.getByText('/plugin marketplace add microsoft/skills-for-fabric')).toBeInTheDocument();

    // Final report: verified badge, installed plugin/version, ZERO_TWO.md path.
    await waitFor(() => expect(screen.getByTestId('prov-verdict')).toHaveTextContent('verified'));
    expect(screen.getByTestId('prov-installed')).toHaveTextContent('powerbi-authoring');
    expect(screen.getByTestId('prov-installed')).toHaveTextContent('1.2.0');
    expect(screen.getByTestId('prov-zerotwo')).toHaveTextContent('ZERO_TWO.md');
    expect(screen.queryByTestId('prov-missing')).not.toBeInTheDocument();
  });

  it('surfaces missing plugins when the report is unverified', async () => {
    const frames = [
      'event:step\ndata:{"command":"/plugin install pbip@community","ok":false,"output":"failed"}\n\n',
      'event:report\ndata:{"agent":"claude","steps":[],"installed":[],"missing":["pbip"],"verified":false,"zeroTwoMdPath":"C:\\\\proj\\\\ZERO_TWO.md"}\n\n',
      'event:done\ndata:{"verified":false}\n\n',
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/agents/provision') return Promise.resolve(sseResponse(frames));
      return Promise.resolve(SIGNED_IN);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ProvisioningPanel agent="claude" projectPath="C:\\proj" />);

    await waitFor(() => expect(screen.getByTestId('prov-provision')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('prov-provision'));

    await waitFor(() => expect(screen.getByTestId('prov-verdict')).toHaveTextContent('issues'));
    expect(screen.getByTestId('prov-missing')).toHaveTextContent('pbip');
  });
});
