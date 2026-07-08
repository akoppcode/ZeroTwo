// Phase 1 Doctor — environment health checklist (spec §3.7).
//
// Single-column checklist of environment requirements (Windows, Node, Git,
// Power BI Desktop, bridge/CLIs, agents). Each row shows a status icon, the
// detected value, and — when the check is not ok — the remediation prose plus
// copyable monospace commands. The header carries the overall status pill and a
// Re-check button that re-fetches `GET /api/doctor`.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DoctorCheck,
  DoctorOverallStatus,
  DoctorReport,
  DoctorStatus,
} from '@open-design/contracts';
import { Icon, type IconName } from './Icon';

type StatusVisual = { icon: IconName; tone: string; label: string };

function statusVisual(status: DoctorStatus): StatusVisual {
  switch (status) {
    case 'ok':
      return { icon: 'check', tone: 'ok', label: 'Passing' };
    case 'warning':
      return { icon: 'alert-triangle', tone: 'warning', label: 'Warning' };
    case 'error':
      return { icon: 'close', tone: 'error', label: 'Error' };
    default:
      return { icon: 'help-circle', tone: 'unknown', label: 'Unknown' };
  }
}

function overallVisual(status: DoctorOverallStatus): StatusVisual {
  return statusVisual(status);
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied (permissions / insecure context); the
      // command stays visible and selectable so the user can copy manually.
    }
  }, [command]);

  return (
    <div className="doctor-view__command">
      <code className="doctor-view__command-text">{command}</code>
      <button
        type="button"
        className="doctor-view__copy"
        onClick={onCopy}
        aria-label={copied ? 'Copied to clipboard' : `Copy command: ${command}`}
        data-testid="doctor-copy"
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

function DoctorRow({ check }: { check: DoctorCheck }) {
  const visual = statusVisual(check.status);
  const showRemediation = check.status !== 'ok';
  return (
    <li
      className="doctor-view__row"
      data-status={check.status}
      data-check-id={check.id}
      data-testid={`doctor-row-${check.id}`}
    >
      <div className="doctor-view__row-head">
        <span
          className={`doctor-view__status doctor-view__status--${visual.tone}`}
          role="img"
          aria-label={visual.label}
        >
          <Icon name={visual.icon} size={15} />
        </span>
        <span className="doctor-view__label">{check.label}</span>
        <span className="doctor-view__detected" data-testid={`doctor-detected-${check.id}`}>
          {check.detected ?? '—'}
        </span>
      </div>
      {showRemediation && (check.remediation || check.commands.length > 0) ? (
        <div className="doctor-view__remediation">
          {check.remediation ? (
            <p className="doctor-view__remediation-text">{check.remediation}</p>
          ) : null}
          {check.commands.length > 0 ? (
            <div className="doctor-view__commands">
              {check.commands.map((cmd) => (
                <div key={cmd.command} className="doctor-view__command-group">
                  <span className="doctor-view__command-label">{cmd.label}</span>
                  <CopyCommand command={cmd.command} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function DoctorView() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/doctor');
      if (!resp.ok) {
        throw new Error(`Doctor check failed (HTTP ${resp.status})`);
      }
      const data = (await resp.json()) as DoctorReport;
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run environment checks.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const overall = report ? overallVisual(report.overall) : null;

  return (
    <section className="doctor-view" aria-labelledby="doctor-title" data-testid="doctor-view">
      <header className="doctor-view__hero">
        <div className="doctor-view__hero-copy">
          <p className="doctor-view__kicker">Environment</p>
          <div className="doctor-view__title-row">
            <h1 id="doctor-title" className="entry-section__title">
              Doctor
            </h1>
            {overall ? (
              <span
                className={`doctor-view__pill doctor-view__pill--${overall.tone}`}
                data-testid="doctor-overall"
              >
                <Icon name={overall.icon} size={13} />
                {overall.label}
              </span>
            ) : null}
          </div>
          <p className="doctor-view__lede">
            Checks the tools and services ZeroTwo needs before it can drive Power BI Desktop.
          </p>
        </div>
        <button
          type="button"
          className="doctor-view__recheck"
          onClick={() => void load()}
          disabled={loading}
          data-testid="doctor-recheck"
        >
          <Icon name={loading ? 'spinner' : 'refresh'} size={14} />
          <span>{loading ? 'Checking…' : 'Re-check'}</span>
        </button>
      </header>

      {error ? (
        <div className="doctor-view__error" role="alert" data-testid="doctor-error">
          <Icon name="alert-triangle" size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {!report && loading ? (
        <div className="doctor-view__loading" data-testid="doctor-loading">
          <Icon name="spinner" size={16} />
          <span>Running environment checks…</span>
        </div>
      ) : null}

      {report ? (
        <ol className="doctor-view__list" data-testid="doctor-list">
          {report.checks.map((check) => (
            <DoctorRow key={check.id} check={check} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
