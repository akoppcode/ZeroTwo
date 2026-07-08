// Rules Studio (design spec §10) — the renderer around the daemon rule API.
//
// Three surfaces in one panel:
//   §10.1 Empty state + template gallery — first-run "no rules yet" with cards
//         from GET /api/rules/templates; "Create from template" opens the form
//         builder pre-filled. No rules ship enabled; a template becomes a rule
//         only when the user creates + saves it.
//   §10.2 Rule editor — a form builder for templated shapes (name, description,
//         severity, params) that builds the rule via POST /api/rules/from-template
//         and PUTs it into the active ruleset, plus a raw JSON editor with lint
//         (POST /api/rules/lint). Each rule row toggles disabled + PUTs and can be
//         tested against the current project (POST /api/projects/:id/inspect).
//   §10.3 Results panel — per-rule pass/fail, severity tone, and failing pages
//         (page + visualCount vs maxVisuals). "Ask agent to fix" builds a prompt
//         from the failures; "Re-run" re-POSTs inspect.
//
// The daemon owns rule evaluation and rule-shape construction — this component
// never evaluates rules client-side (spec §10) and delegates rule JSON to the
// from-template endpoint rather than duplicating the JSON-Logic here.
//
// TODO(Workspace phase): host this inside the Workspace shell and share the
// project/session context instead of the standalone projects-view entry.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { randomUUID } from '../utils/uuid';
import { Icon } from './Icon';

type Severity = 'warning' | 'error';

interface RuleTemplateSummary {
  templateId: string;
  title: string;
  description: string;
  defaultSeverity: Severity;
}

interface FabRule {
  id: string;
  name: string;
  description: string;
  disabled: boolean;
  part: string;
  test: unknown;
  logType: Severity;
  zerotwo?: { check: string; maxVisuals: number };
}

interface RuleSet {
  rules: FabRule[];
}

interface FailingPage {
  page: string;
  visualCount?: number;
  maxVisuals?: number;
}

interface RuleResult {
  ruleId: string;
  ruleName: string;
  logType: Severity;
  pass: boolean;
  failingPages: FailingPage[];
}

interface Props {
  projectId: string;
  /**
   * Optional hook to push a "fix these rules" prompt into the live agent
   * session. When absent the prompt is still shown in a copyable panel.
   */
  onAskAgent?: (prompt: string) => void;
}

const RULESET_NAME = 'default';
const MAX_VISUALS_TEMPLATE = 'max-visuals-per-page';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** Structured "please fix these failing rules" prompt for the agent (§10.3). */
function buildFixPrompt(results: RuleResult[]): string {
  const lines = [
    'These Power BI report rules are failing for the current project. Please update the report so they pass.',
    '',
  ];
  for (const r of results) {
    lines.push(`- Rule "${r.ruleName}" (${r.logType}) [${r.ruleId}]`);
    for (const p of r.failingPages) {
      const count =
        p.visualCount != null && p.maxVisuals != null
          ? ` — ${p.visualCount} visuals (max ${p.maxVisuals})`
          : '';
      lines.push(`    • page "${p.page}"${count}`);
    }
  }
  return lines.join('\n');
}

function severityToneClass(sev: Severity): string {
  return sev === 'error' ? 'zt-rules__sev--error' : 'zt-rules__sev--warning';
}

export function RulesStudio({ projectId, onAskAgent }: Props) {
  const [templates, setTemplates] = useState<RuleTemplateSummary[]>([]);
  const [ruleset, setRuleset] = useState<RuleSet>({ rules: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editor mode: the form builder (templated shapes) or the raw JSON editor.
  const [mode, setMode] = useState<'form' | 'raw'>('form');

  // Form builder state.
  const [formTemplate, setFormTemplate] = useState<RuleTemplateSummary | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formSeverity, setFormSeverity] = useState<Severity>('warning');
  const [formMaxVisuals, setFormMaxVisuals] = useState(10);
  const [baseRule, setBaseRule] = useState<FabRule | null>(null);

  // Raw editor state.
  const [rawText, setRawText] = useState('');
  const [lintErrors, setLintErrors] = useState<string[]>([]);

  // Inspection results, keyed by ruleId.
  const [results, setResults] = useState<Record<string, RuleResult>>({});
  const [inspecting, setInspecting] = useState(false);
  const [askPrompt, setAskPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Stable session id for inspect runs (spec §9), same approach as PipelinePanel.
  const sessionId = useMemo(() => randomUUID(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tplRes, rsRes] = await Promise.all([
        fetch('/api/rules/templates'),
        fetch(`/api/rules/rulesets/${RULESET_NAME}`),
      ]);
      if (tplRes.ok) {
        const data = (await tplRes.json()) as { templates: RuleTemplateSummary[] };
        setTemplates(data.templates ?? []);
      }
      if (rsRes.ok) {
        const data = (await rsRes.json()) as { ruleset: RuleSet };
        setRuleset({ rules: data.ruleset?.rules ?? [] });
      } else {
        // No saved ruleset yet — first run empty state (§10.1).
        setRuleset({ rules: [] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Sync the raw editor text with the ruleset whenever we enter raw mode.
  useEffect(() => {
    if (mode === 'raw') {
      setRawText(JSON.stringify(ruleset, null, 2));
      setLintErrors([]);
    }
  }, [mode, ruleset]);

  // Regenerate the rule preview from the daemon whenever the templated params
  // change (spec §10.2 — "on change it calls POST from-template").
  useEffect(() => {
    if (!formTemplate) return;
    let cancelled = false;
    const params: Record<string, number | string> = { severity: formSeverity };
    if (formTemplate.templateId === MAX_VISUALS_TEMPLATE) params.maxVisuals = formMaxVisuals;
    void (async () => {
      try {
        const res = await fetch('/api/rules/from-template', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ templateId: formTemplate.templateId, params }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { rule: FabRule };
        if (cancelled || !data.rule) return;
        setBaseRule(data.rule);
        // Seed the name/description fields from the generated rule the first time.
        setFormName((prev) => prev || data.rule.name);
        setFormDescription((prev) => prev || data.rule.description);
      } catch {
        // Preview is best-effort; Save re-builds from the same endpoint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formTemplate, formSeverity, formMaxVisuals]);

  const generatedRule = useMemo<FabRule | null>(() => {
    if (!baseRule) return null;
    return {
      ...baseRule,
      name: formName || baseRule.name,
      description: formDescription || baseRule.description,
      logType: formSeverity,
    };
  }, [baseRule, formName, formDescription, formSeverity]);

  const openForm = useCallback((tpl: RuleTemplateSummary) => {
    setFormTemplate(tpl);
    setFormName('');
    setFormDescription('');
    setFormSeverity(tpl.defaultSeverity);
    setFormMaxVisuals(10);
    setBaseRule(null);
    setError(null);
  }, []);

  const closeForm = useCallback(() => {
    setFormTemplate(null);
    setBaseRule(null);
  }, []);

  /** PUT the ruleset; surface lint errors on a 400 (spec §10.2). Returns ok. */
  const saveRuleset = useCallback(async (next: RuleSet): Promise<boolean> => {
    try {
      const res = await fetch(`/api/rules/rulesets/${RULESET_NAME}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ruleset: next }),
      });
      if (res.ok) {
        setRuleset(next);
        setLintErrors([]);
        return true;
      }
      const data = (await res.json().catch(() => null)) as
        | { error?: { message?: string }; lint?: { errors?: string[] } }
        | null;
      setLintErrors(data?.lint?.errors ?? [data?.error?.message ?? 'Ruleset could not be saved.']);
      return false;
    } catch (err) {
      setLintErrors([err instanceof Error ? err.message : 'Ruleset could not be saved.']);
      return false;
    }
  }, []);

  const saveFromForm = useCallback(async () => {
    if (!generatedRule) return;
    const next: RuleSet = {
      rules: [...ruleset.rules.filter((r) => r.id !== generatedRule.id), generatedRule],
    };
    const ok = await saveRuleset(next);
    if (ok) closeForm();
  }, [generatedRule, ruleset, saveRuleset, closeForm]);

  const toggleRule = useCallback(
    async (rule: FabRule) => {
      const next: RuleSet = {
        rules: ruleset.rules.map((r) => (r.id === rule.id ? { ...r, disabled: !r.disabled } : r)),
      };
      await saveRuleset(next);
    },
    [ruleset, saveRuleset],
  );

  const validateRaw = useCallback(async () => {
    try {
      const res = await fetch('/api/rules/lint', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ raw: rawText }),
      });
      const data = (await res.json()) as { ok: boolean; errors?: string[] };
      setLintErrors(data.ok ? [] : data.errors ?? ['Ruleset is invalid.']);
    } catch (err) {
      setLintErrors([err instanceof Error ? err.message : 'Validation failed.']);
    }
  }, [rawText]);

  const saveRaw = useCallback(async () => {
    let parsed: RuleSet;
    try {
      parsed = JSON.parse(rawText) as RuleSet;
    } catch (err) {
      setLintErrors([`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`]);
      return;
    }
    await saveRuleset(parsed);
  }, [rawText, saveRuleset]);

  const runInspect = useCallback(async () => {
    setInspecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/inspect`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ rulesetName: RULESET_NAME, sessionId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? `Inspection failed (HTTP ${res.status}).`);
      }
      const data = (await res.json()) as { results: RuleResult[] };
      const byId: Record<string, RuleResult> = {};
      for (const r of data.results ?? []) byId[r.ruleId] = r;
      setResults(byId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inspection failed.');
    } finally {
      setInspecting(false);
    }
  }, [projectId, sessionId]);

  const failingResults = useMemo(
    () => Object.values(results).filter((r) => !r.pass),
    [results],
  );

  const askAgent = useCallback(
    (subset: RuleResult[]) => {
      const prompt = buildFixPrompt(subset);
      setAskPrompt(prompt);
      onAskAgent?.(prompt);
    },
    [onAskAgent],
  );

  const copyPrompt = useCallback(async () => {
    if (!askPrompt) return;
    try {
      await navigator.clipboard.writeText(askPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be blocked; the prompt stays selectable in the panel.
    }
  }, [askPrompt]);

  const hasRules = ruleset.rules.length > 0;

  return (
    <section className="zt-rules" aria-labelledby="zt-rules-title" data-testid="rules-studio">
      <header className="zt-rules__head">
        <div className="zt-rules__head-copy">
          <p className="zt-projects__kicker">Quality</p>
          <h2 id="zt-rules-title" className="zt-pipeline__title">
            Rules Studio
          </h2>
          <p className="zt-projects__lede">
            Codify report conventions as rules, then test them against this project. Zero Two runs the
            checks — it never grades the report in the browser.
          </p>
        </div>
        <div className="zt-rules__head-actions">
          <div className="zt-rules__mode" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'form'}
              className={`zt-rules__mode-btn${mode === 'form' ? ' is-active' : ''}`}
              onClick={() => setMode('form')}
              data-testid="rules-mode-form"
            >
              Form
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'raw'}
              className={`zt-rules__mode-btn${mode === 'raw' ? ' is-active' : ''}`}
              onClick={() => setMode('raw')}
              data-testid="rules-mode-raw"
            >
              Raw JSON
            </button>
          </div>
          {hasRules ? (
            <button
              type="button"
              className="zt-btn zt-btn--primary"
              onClick={() => void runInspect()}
              disabled={inspecting}
              data-testid="rules-rerun"
            >
              <Icon name={inspecting ? 'spinner' : 'play'} size={14} />
              <span>{inspecting ? 'Inspecting…' : 'Re-run'}</span>
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="zt-notice zt-notice--error" role="alert" data-testid="rules-error">
          <Icon name="alert-triangle" size={16} />
          <div>
            <p className="zt-notice__title">Something went wrong</p>
            <p className="zt-notice__text">{error}</p>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="zt-activity" data-testid="rules-loading">
          <Icon name="spinner" size={16} />
          <span>Loading rules…</span>
        </div>
      ) : mode === 'raw' ? (
        <div className="zt-rules__raw" data-testid="rules-raw">
          <label className="zt-field__label" htmlFor="rules-raw-textarea">
            Ruleset JSON
          </label>
          <textarea
            id="rules-raw-textarea"
            className="zt-input zt-rules__raw-textarea"
            spellCheck={false}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            data-testid="rules-raw-textarea"
            aria-describedby="rules-lint-errors"
          />
          <div className="zt-actions">
            <button
              type="button"
              className="zt-btn"
              onClick={() => void validateRaw()}
              data-testid="rules-raw-validate"
            >
              <Icon name="check" size={14} />
              <span>Validate</span>
            </button>
            <button
              type="button"
              className="zt-btn zt-btn--primary"
              onClick={() => void saveRaw()}
              data-testid="rules-raw-save"
            >
              <span>Save ruleset</span>
            </button>
          </div>
          <div
            id="rules-lint-errors"
            className="zt-rules__lint"
            role="status"
            aria-live="polite"
            data-testid="rules-lint-errors"
          >
            {lintErrors.length > 0 ? (
              <ul className="zt-rules__lint-list">
                {lintErrors.map((err, i) => (
                  <li key={i} className="zt-rules__lint-item">
                    <Icon name="close" size={13} />
                    <span>{err}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {!hasRules && !formTemplate ? (
            <div className="zt-rules__empty" data-testid="rules-empty">
              <p className="zt-rules__empty-title">No rules yet — create your first rule</p>
              <p className="zt-rules__empty-lede">
                Start from a template below. Templates are inert until you create and save one.
              </p>
            </div>
          ) : null}

          {hasRules ? (
            <ol className="zt-rules__list" data-testid="rules-list">
              {ruleset.rules.map((rule) => {
                const result = results[rule.id];
                return (
                  <li key={rule.id} className="zt-rules__row" data-testid={`rule-row-${rule.id}`}>
                    <div className="zt-rules__row-head">
                      <span className={`zt-rules__sev ${severityToneClass(rule.logType)}`}>
                        {rule.logType}
                      </span>
                      <div className="zt-rules__row-copy">
                        <span className="zt-rules__row-name">{rule.name}</span>
                        <code className="zt-rules__row-id">{rule.id}</code>
                      </div>
                      <div className="zt-rules__row-actions">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={!rule.disabled}
                          aria-label={`${rule.disabled ? 'Enable' : 'Disable'} rule ${rule.name}`}
                          className={`zt-rules__toggle${rule.disabled ? '' : ' is-on'}`}
                          onClick={() => void toggleRule(rule)}
                          data-testid={`rule-toggle-${rule.id}`}
                        >
                          <span className="zt-rules__toggle-knob" />
                        </button>
                        <button
                          type="button"
                          className="zt-btn"
                          onClick={() => void runInspect()}
                          disabled={inspecting}
                          data-testid={`rule-test-${rule.id}`}
                        >
                          <Icon name={inspecting ? 'spinner' : 'play'} size={13} />
                          <span>Test against current project</span>
                        </button>
                      </div>
                    </div>
                    {result ? (
                      <div
                        className={`zt-rules__result zt-rules__result--${result.pass ? 'pass' : 'fail'}`}
                        data-testid={`rule-result-${rule.id}`}
                        data-pass={result.pass ? 'true' : 'false'}
                      >
                        <span className="zt-rules__result-badge">
                          <Icon name={result.pass ? 'check' : 'close'} size={13} />
                          {result.pass ? 'Passing' : 'Failing'}
                        </span>
                        {!result.pass && result.failingPages.length > 0 ? (
                          <ul className="zt-rules__failing">
                            {result.failingPages.map((p) => (
                              <li
                                key={p.page}
                                className="zt-rules__failing-item"
                                data-testid={`rule-failing-${rule.id}-${p.page}`}
                              >
                                <span className="zt-rules__failing-page">{p.page}</span>
                                {p.visualCount != null ? (
                                  <span className="zt-rules__failing-count">
                                    {p.visualCount}
                                    {p.maxVisuals != null ? ` / ${p.maxVisuals}` : ''} visuals
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {!result.pass ? (
                          <button
                            type="button"
                            className="zt-btn zt-btn--ghost"
                            onClick={() => askAgent([result])}
                            data-testid={`rule-ask-${rule.id}`}
                          >
                            <Icon name="sparkles" size={13} />
                            <span>Ask agent to fix</span>
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}

          {hasRules && failingResults.length > 0 ? (
            <div className="zt-rules__panel-actions" data-testid="rules-panel-actions">
              <button
                type="button"
                className="zt-btn"
                onClick={() => askAgent(failingResults)}
                data-testid="rules-ask-all"
              >
                <Icon name="sparkles" size={14} />
                <span>Ask agent to fix all failures</span>
              </button>
            </div>
          ) : null}

          {formTemplate ? (
            <div className="zt-rules__form" data-testid="rule-form">
              <div className="zt-rules__form-head">
                <p className="zt-rules__form-title">New rule — {formTemplate.title}</p>
                <button
                  type="button"
                  className="zt-btn zt-btn--ghost"
                  onClick={closeForm}
                  data-testid="rule-form-cancel"
                >
                  <Icon name="close" size={13} />
                  <span>Cancel</span>
                </button>
              </div>
              <div className="zt-field">
                <label className="zt-field__label" htmlFor="rule-form-name">
                  Name
                </label>
                <input
                  id="rule-form-name"
                  className="zt-input"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  data-testid="rule-form-name"
                />
              </div>
              <div className="zt-field">
                <label className="zt-field__label" htmlFor="rule-form-description">
                  Description
                </label>
                <textarea
                  id="rule-form-description"
                  className="zt-textarea"
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  data-testid="rule-form-description"
                />
              </div>
              <div className="zt-field__row">
                <div className="zt-field">
                  <label className="zt-field__label" htmlFor="rule-form-severity">
                    Severity
                  </label>
                  <select
                    id="rule-form-severity"
                    className="zt-input"
                    value={formSeverity}
                    onChange={(e) => setFormSeverity(e.target.value as Severity)}
                    data-testid="rule-form-severity"
                  >
                    <option value="warning">warning</option>
                    <option value="error">error</option>
                  </select>
                </div>
                {formTemplate.templateId === MAX_VISUALS_TEMPLATE ? (
                  <div className="zt-field">
                    <label className="zt-field__label" htmlFor="rule-form-maxVisuals">
                      Max visuals per page
                    </label>
                    <input
                      id="rule-form-maxVisuals"
                      type="number"
                      min={1}
                      className="zt-input"
                      value={formMaxVisuals}
                      onChange={(e) => setFormMaxVisuals(Number(e.target.value))}
                      data-testid="rule-form-maxVisuals"
                    />
                  </div>
                ) : null}
              </div>
              {generatedRule ? (
                <div className="zt-field">
                  <span className="zt-field__label">Generated rule</span>
                  <pre className="zt-rules__preview" data-testid="rule-form-preview">
                    {JSON.stringify(generatedRule, null, 2)}
                  </pre>
                </div>
              ) : null}
              {lintErrors.length > 0 ? (
                <div className="zt-rules__lint" role="alert">
                  <ul className="zt-rules__lint-list">
                    {lintErrors.map((err, i) => (
                      <li key={i} className="zt-rules__lint-item">
                        <Icon name="close" size={13} />
                        <span>{err}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="zt-actions">
                <span />
                <button
                  type="button"
                  className="zt-btn zt-btn--primary"
                  onClick={() => void saveFromForm()}
                  disabled={!generatedRule}
                  data-testid="rule-form-save"
                >
                  <span>Save rule</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="zt-rules__gallery" data-testid="rules-gallery">
              <p className="zt-rules__gallery-title">
                {hasRules ? 'Add another rule from a template' : 'Templates'}
              </p>
              <div className="zt-rules__gallery-grid">
                {templates.map((tpl) => (
                  <div
                    key={tpl.templateId}
                    className="zt-rules__template"
                    data-testid={`rule-template-${tpl.templateId}`}
                  >
                    <span className={`zt-rules__sev ${severityToneClass(tpl.defaultSeverity)}`}>
                      {tpl.defaultSeverity}
                    </span>
                    <span className="zt-rules__template-title">{tpl.title}</span>
                    <span className="zt-rules__template-desc">{tpl.description}</span>
                    <button
                      type="button"
                      className="zt-btn"
                      onClick={() => openForm(tpl)}
                      data-testid={`rule-template-create-${tpl.templateId}`}
                    >
                      <Icon name="plus" size={13} />
                      <span>Create from template</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {askPrompt ? (
        <div className="zt-rules__ask" data-testid="rules-ask-prompt">
          <div className="zt-rules__ask-head">
            <span>Agent prompt</span>
            <button type="button" className="zt-copy" onClick={() => void copyPrompt()}>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          {/* TODO(chat phase): send this straight into the live agent session. */}
          <pre className="zt-rules__ask-body">{askPrompt}</pre>
        </div>
      ) : null}
    </section>
  );
}
