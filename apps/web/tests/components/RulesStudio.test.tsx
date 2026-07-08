// @vitest-environment jsdom

// Rules Studio (spec §10) — jsdom coverage of the gallery/editor/results wiring
// against a mocked daemon rule API.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RulesStudio } from '../../src/components/RulesStudio';

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const TEMPLATES = [
  {
    templateId: 'max-visuals-per-page',
    title: 'Max visuals per page',
    description: 'Keep pages readable by capping how many visuals a page can have.',
    defaultSeverity: 'warning',
  },
  {
    templateId: 'axis-titles-required',
    title: 'Axis titles required',
    description: 'Cartesian charts should show axis titles.',
    defaultSeverity: 'warning',
  },
];

const MAX_VISUALS_RULE = {
  id: 'MAX_VISUALS_PER_PAGE_10',
  name: 'At most 10 visuals per page',
  description: 'Flags any report page with more than 10 visuals.',
  disabled: false,
  part: 'Page',
  test: [{ '<=': [{ count: { var: 'Visuals' } }, 10] }, {}, true],
  logType: 'warning',
  zerotwo: { check: 'maxVisualsPerPage', maxVisuals: 10 },
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Route the mock fetch by method + path. `rulesetOnLoad` seeds the ruleset
 * returned by the initial GET (null → 404 empty state). Extra handlers can be
 * layered per test via `overrides`.
 */
function installFetch(opts: {
  rulesetOnLoad?: { rules: unknown[] } | null;
  inspect?: unknown;
  lint?: unknown;
  put?: { status: number; body?: unknown };
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/rules/templates') return json({ templates: TEMPLATES });

    if (url === `/api/rules/rulesets/default` && method === 'GET') {
      return opts.rulesetOnLoad
        ? json({ ruleset: opts.rulesetOnLoad })
        : json({ error: { message: 'not found' } }, 404);
    }

    if (url === '/api/rules/from-template' && method === 'POST') {
      return json({ rule: MAX_VISUALS_RULE });
    }

    if (url === `/api/rules/rulesets/default` && method === 'PUT') {
      const status = opts.put?.status ?? 200;
      return json(opts.put?.body ?? { ok: true }, status);
    }

    if (url === '/api/rules/lint' && method === 'POST') {
      return json(opts.lint ?? { ok: true, errors: [] });
    }

    if (url.endsWith('/inspect') && method === 'POST') {
      return json(opts.inspect ?? { id: 'run-1', passed: true, results: [] });
    }

    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('RulesStudio', () => {
  it('renders the empty state with the template gallery on first run', async () => {
    installFetch({ rulesetOnLoad: null });
    render(<RulesStudio projectId="proj-1" />);

    await waitFor(() => screen.getByTestId('rules-empty'));
    expect(screen.getByTestId('rules-empty')).toHaveTextContent('No rules yet');
    // One card per template from GET /api/rules/templates.
    expect(screen.getByTestId('rule-template-max-visuals-per-page')).toBeInTheDocument();
    expect(screen.getByTestId('rule-template-axis-titles-required')).toBeInTheDocument();
  });

  it('creates a rule from the max-visuals template and PUTs the ruleset on Save', async () => {
    const fetchMock = installFetch({ rulesetOnLoad: null });
    render(<RulesStudio projectId="proj-1" />);

    await waitFor(() => screen.getByTestId('rules-empty'));
    fireEvent.click(screen.getByTestId('rule-template-create-max-visuals-per-page'));

    // The form builds the rule via POST /api/rules/from-template.
    await waitFor(() => screen.getByTestId('rule-form-preview'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rules/from-template',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.click(screen.getByTestId('rule-form-save'));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) => u === '/api/rules/rulesets/default' && (i as RequestInit)?.method === 'PUT',
      );
      expect(put).toBeTruthy();
    });
    const putCall = fetchMock.mock.calls.find(
      ([u, i]) => u === '/api/rules/rulesets/default' && (i as RequestInit)?.method === 'PUT',
    )!;
    const body = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(body.ruleset.rules).toHaveLength(1);
    expect(body.ruleset.rules[0].id).toBe('MAX_VISUALS_PER_PAGE_10');

    // Saved rule now shows in the list.
    await waitFor(() => screen.getByTestId('rule-row-MAX_VISUALS_PER_PAGE_10'));
  });

  it('tests a rule against the project and renders the failing page + visual count', async () => {
    const inspect = {
      id: 'run-1',
      passed: false,
      results: [
        {
          ruleId: 'MAX_VISUALS_PER_PAGE_10',
          ruleName: 'At most 10 visuals per page',
          logType: 'warning',
          pass: false,
          failingPages: [{ page: 'Overview', visualCount: 14, maxVisuals: 10 }],
        },
      ],
    };
    const fetchMock = installFetch({ rulesetOnLoad: { rules: [MAX_VISUALS_RULE] }, inspect });
    render(<RulesStudio projectId="proj-1" />);

    await waitFor(() => screen.getByTestId('rule-row-MAX_VISUALS_PER_PAGE_10'));
    fireEvent.click(screen.getByTestId('rule-test-MAX_VISUALS_PER_PAGE_10'));

    // POST inspect fired with the ruleset name + a session id.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/projects/proj-1/inspect' && (i as RequestInit)?.method === 'POST'),
      ).toBe(true),
    );
    const inspectCall = fetchMock.mock.calls.find(
      ([u]) => String(u) === '/api/projects/proj-1/inspect',
    )!;
    const inspectBody = JSON.parse((inspectCall[1] as RequestInit).body as string);
    expect(inspectBody.rulesetName).toBe('default');
    expect(typeof inspectBody.sessionId).toBe('string');

    // Failing page + visual count rendered inline.
    const result = await screen.findByTestId('rule-result-MAX_VISUALS_PER_PAGE_10');
    expect(result).toHaveAttribute('data-pass', 'false');
    const failing = screen.getByTestId('rule-failing-MAX_VISUALS_PER_PAGE_10-Overview');
    expect(failing).toHaveTextContent('Overview');
    expect(failing).toHaveTextContent('14');
    expect(failing).toHaveTextContent('10');

    // "Re-run" fires a second inspect POST.
    fireEvent.click(screen.getByTestId('rules-rerun'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) => String(u) === '/api/projects/proj-1/inspect').length,
      ).toBe(2),
    );
  });

  it('surfaces lint errors from the raw editor for invalid JSON', async () => {
    installFetch({
      rulesetOnLoad: { rules: [MAX_VISUALS_RULE] },
      lint: { ok: false, errors: ['Unexpected token } in JSON at position 12'] },
    });
    render(<RulesStudio projectId="proj-1" />);

    await waitFor(() => screen.getByTestId('rule-row-MAX_VISUALS_PER_PAGE_10'));
    fireEvent.click(screen.getByTestId('rules-mode-raw'));

    const textarea = await screen.findByTestId('rules-raw-textarea');
    fireEvent.change(textarea, { target: { value: '{ not valid json }' } });
    fireEvent.click(screen.getByTestId('rules-raw-validate'));

    const errors = await screen.findByTestId('rules-lint-errors');
    await waitFor(() => expect(errors).toHaveTextContent('Unexpected token'));
  });

  it('builds a fix prompt from failures and calls onAskAgent', async () => {
    const inspect = {
      id: 'run-1',
      passed: false,
      results: [
        {
          ruleId: 'MAX_VISUALS_PER_PAGE_10',
          ruleName: 'At most 10 visuals per page',
          logType: 'warning',
          pass: false,
          failingPages: [{ page: 'Overview', visualCount: 14, maxVisuals: 10 }],
        },
      ],
    };
    const onAskAgent = vi.fn();
    installFetch({ rulesetOnLoad: { rules: [MAX_VISUALS_RULE] }, inspect });
    render(<RulesStudio projectId="proj-1" onAskAgent={onAskAgent} />);

    await waitFor(() => screen.getByTestId('rule-row-MAX_VISUALS_PER_PAGE_10'));
    fireEvent.click(screen.getByTestId('rules-rerun'));

    await screen.findByTestId('rules-ask-all');
    fireEvent.click(screen.getByTestId('rules-ask-all'));

    expect(onAskAgent).toHaveBeenCalledTimes(1);
    const prompt = onAskAgent.mock.calls[0]![0] as string;
    expect(prompt).toContain('At most 10 visuals per page');
    expect(prompt).toContain('Overview');
    expect(prompt).toContain('14 visuals (max 10)');

    // The prompt is also shown in a copyable panel.
    const panel = await screen.findByTestId('rules-ask-prompt');
    expect(within(panel).getByText(/Overview/)).toBeInTheDocument();
  });
});
