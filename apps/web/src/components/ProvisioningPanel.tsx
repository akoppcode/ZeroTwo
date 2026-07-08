// Provisioning report UI (design spec §3.6) — the shared Ready-step component
// for the attach + new-report wizards.
//
// On mount it checks the agent's subscription-auth status
// (GET /api/agents/:agent/auth). Signed out, it surfaces the CLI login command
// in a copyable chip and blocks provisioning until the user re-checks. Signed
// in, a "Provision Power BI skills" button POSTs to /api/agents/provision and
// reads the SSE stream: each `step` frame appends a live row, the final `report`
// renders the verified badge (or the missing plugins + failed steps when
// unverified), the installed plugin/version list, and the ZERO_TWO.md path.
//
// Provisioning is not a hard gate — the wizard's "Open workspace" stays enabled —
// but the verified/unverified state is surfaced clearly.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { ZeroTwoAgent } from './ZeroTwoAgentPicker';

interface AuthStatus {
  agent: string;
  loggedIn: boolean;
  user: string | null;
  loginCommand: string | null;
}

interface ProvisioningStepResult {
  command: string;
  ok: boolean;
  output: string;
}

interface InstalledPlugin {
  ref: string;
  version: string;
}

interface ProvisioningReport {
  agent: string;
  steps: ProvisioningStepResult[];
  installed: InstalledPlugin[];
  missing: string[];
  verified: boolean;
  zeroTwoMdPath: string;
}

type AuthPhase = 'loading' | 'signed-in' | 'signed-out' | 'error';
type ProvPhase = 'idle' | 'running' | 'done' | 'error';

interface Props {
  agent: ZeroTwoAgent;
  projectPath: string;
}

const AGENT_LABEL: Record<ZeroTwoAgent, string> = {
  claude: 'Claude Code',
  copilot: 'Copilot',
};

/**
 * Read the daemon SSE stream, invoking `onEvent` for each `event:`/`data:` frame.
 * Mirrors `readWatchStream` in AttachReportWizard (same daemon SSE framing).
 */
async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        try {
          onEvent(event, JSON.parse(dataLines.join('\n')) as Record<string, unknown>);
        } catch {
          // Ignore keepalive / non-JSON frames.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Monospace command chip with a copy button (spec §3.6 login command). */
function CommandChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be blocked; the command stays visible and selectable.
    }
  }, [command]);

  return (
    <div className="zt-path-card">
      <span className="zt-path-card__label">Run</span>
      <code className="zt-path-card__value">{command}</code>
      <button
        type="button"
        className="zt-copy"
        onClick={onCopy}
        aria-label={copied ? 'Copied to clipboard' : `Copy command: ${command}`}
        data-testid="prov-copy-login"
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

export function ProvisioningPanel({ agent, projectPath }: Props) {
  const [authPhase, setAuthPhase] = useState<AuthPhase>('loading');
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [provPhase, setProvPhase] = useState<ProvPhase>('idle');
  const [steps, setSteps] = useState<ProvisioningStepResult[]>([]);
  const [report, setReport] = useState<ProvisioningReport | null>(null);
  const [provError, setProvError] = useState<string | null>(null);

  const checkAuth = useCallback(async () => {
    setAuthPhase('loading');
    setAuthError(null);
    try {
      const res = await fetch(`/api/agents/${agent}/auth`);
      if (!res.ok) throw new Error(`Sign-in check failed (HTTP ${res.status}).`);
      const data = (await res.json()) as AuthStatus;
      setAuth(data);
      setAuthPhase(data.loggedIn ? 'signed-in' : 'signed-out');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in check failed.');
      setAuthPhase('error');
    }
  }, [agent]);

  // Check auth on entering the Ready step (and whenever the agent changes).
  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const provision = useCallback(async () => {
    setProvPhase('running');
    setSteps([]);
    setReport(null);
    setProvError(null);
    try {
      const res = await fetch('/api/agents/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, projectPath }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Provisioning could not start (HTTP ${res.status}).`);
      }
      let failed = false;
      await readSseStream(res.body, (event, data) => {
        if (event === 'step') {
          setSteps((prev) => [...prev, data as unknown as ProvisioningStepResult]);
        } else if (event === 'report') {
          setReport(data as unknown as ProvisioningReport);
        } else if (event === 'done') {
          setProvPhase('done');
        } else if (event === 'error') {
          failed = true;
          setProvError(typeof data.message === 'string' ? data.message : 'Provisioning failed.');
          setProvPhase('error');
        }
      });
      // Settle if the stream ended without an explicit terminal frame.
      if (!failed) setProvPhase((prev) => (prev === 'running' ? 'done' : prev));
    } catch (err) {
      setProvError(err instanceof Error ? err.message : 'Provisioning failed.');
      setProvPhase('error');
    }
  }, [agent, projectPath]);

  const agentLabel = AGENT_LABEL[agent];

  return (
    <section className="zt-prov" aria-label="Provisioning" data-testid="provisioning-panel">
      {authPhase === 'loading' ? (
        <div className="zt-activity" role="status" data-testid="prov-auth-loading">
          <Icon name="spinner" size={16} />
          <span>Checking {agentLabel} sign-in…</span>
        </div>
      ) : null}

      {authPhase === 'error' ? (
        <div className="zt-notice zt-notice--error" role="alert" data-testid="prov-auth-error">
          <Icon name="alert-triangle" size={16} />
          <div>
            <p className="zt-notice__title">Could not check sign-in</p>
            <p className="zt-notice__text">{authError}</p>
            <button type="button" className="zt-btn" onClick={() => void checkAuth()} data-testid="prov-recheck">
              Re-check
            </button>
          </div>
        </div>
      ) : null}

      {authPhase === 'signed-out' && auth ? (
        <div className="zt-notice zt-notice--warning" role="alert" data-testid="prov-signed-out">
          <Icon name="log-out" size={16} />
          <div className="zt-prov__auth-body">
            <p className="zt-notice__title">Sign in to {agentLabel}</p>
            <p className="zt-notice__text">
              Zero Two never handles API keys — run the CLI login below, then re-check to continue.
            </p>
            {auth.loginCommand ? <CommandChip command={auth.loginCommand} /> : null}
            <button type="button" className="zt-btn" onClick={() => void checkAuth()} data-testid="prov-recheck">
              <Icon name="refresh" size={14} />
              <span>Re-check</span>
            </button>
          </div>
        </div>
      ) : null}

      {authPhase === 'signed-in' && auth ? (
        <>
          <div className="zt-prov__account" data-testid="prov-signed-in">
            <span className="zt-prov__account-badge">
              <Icon name="check" size={14} />
            </span>
            <div className="zt-prov__account-copy">
              <span className="zt-prov__account-label">{agentLabel} signed in</span>
              <span className="zt-prov__account-user">{auth.user ?? 'Active subscription'}</span>
            </div>
          </div>

          {provPhase === 'idle' ? (
            <button
              type="button"
              className="zt-btn zt-btn--primary"
              onClick={() => void provision()}
              data-testid="prov-provision"
            >
              <Icon name="sparkles" size={14} />
              <span>Provision Power BI skills</span>
            </button>
          ) : null}

          {steps.length > 0 || provPhase === 'running' ? (
            <ol
              className="zt-prov__steps"
              aria-live="polite"
              aria-label="Provisioning progress"
              data-testid="prov-steps"
            >
              {steps.map((step, index) => (
                <li
                  key={`${step.command}-${index}`}
                  className={`zt-prov__step zt-prov__step--${step.ok ? 'ok' : 'fail'}`}
                  data-testid="prov-step"
                >
                  <span className={`zt-prov__step-icon zt-prov__step-icon--${step.ok ? 'ok' : 'fail'}`}>
                    <Icon name={step.ok ? 'check' : 'close'} size={13} />
                  </span>
                  <code className="zt-prov__step-command">{step.command}</code>
                </li>
              ))}
              {provPhase === 'running' ? (
                <li className="zt-prov__step zt-prov__step--running" data-testid="prov-step-running">
                  <span className="zt-prov__step-icon zt-prov__step-icon--running">
                    <Icon name="spinner" size={13} />
                  </span>
                  <span className="zt-prov__step-command">Working…</span>
                </li>
              ) : null}
            </ol>
          ) : null}

          {provError ? (
            <div className="zt-notice zt-notice--error" role="alert" data-testid="prov-error">
              <Icon name="alert-triangle" size={16} />
              <div>
                <p className="zt-notice__title">Provisioning failed</p>
                <p className="zt-notice__text">{provError}</p>
                <button type="button" className="zt-btn" onClick={() => void provision()} data-testid="prov-retry">
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {report ? (
            <div className="zt-prov__report" data-testid="prov-report">
              <div
                className={`zt-prov__verdict zt-prov__verdict--${report.verified ? 'ok' : 'warn'}`}
                data-testid="prov-verdict"
              >
                <Icon name={report.verified ? 'check' : 'alert-triangle'} size={15} />
                <span>{report.verified ? 'Skills provisioned & verified' : 'Provisioned with issues'}</span>
              </div>

              {!report.verified && report.missing.length > 0 ? (
                <div className="zt-prov__missing" data-testid="prov-missing">
                  <span className="zt-prov__list-label">Missing plugins</span>
                  <ul>
                    {report.missing.map((ref) => (
                      <li key={ref}>{ref}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {report.installed.length > 0 ? (
                <div className="zt-prov__installed" data-testid="prov-installed">
                  <span className="zt-prov__list-label">Installed</span>
                  <ul>
                    {report.installed.map((plugin) => (
                      <li key={plugin.ref}>
                        <code className="zt-prov__plugin-ref">{plugin.ref}</code>
                        <span className="zt-prov__plugin-version">{plugin.version}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <p className="zt-prov__zerotwo" data-testid="prov-zerotwo">
                <Icon name="file-text" size={13} />
                <span>
                  ZERO_TWO.md written to <code>{report.zeroTwoMdPath}</code>
                </span>
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
