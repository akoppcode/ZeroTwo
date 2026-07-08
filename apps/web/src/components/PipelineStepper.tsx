// Pipeline stage stepper (design spec §6.2) — renders the five post-turn stages
// (validate → inspect → reload → screenshot → commit) as a horizontal stepper
// driven by `pipeline:stage` SSE events. Each stage shows running (spinner) /
// passed (green) / failed (red) / skipped (grey); validate surfaces its retry
// attempt count; a failed reload / screenshot renders the remediation as a
// Doctor-style banner. The running stage is announced via an aria-live region.

import { Icon, type IconName } from './Icon';
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type StageName,
  type StageRemediation,
  type StageView,
} from './pipeline-types';

interface Props {
  /** Current view state per stage; missing / 'pending' stages render inert. */
  stages: Record<StageName, StageView>;
  /** Set when reload / screenshot failed — drives the Doctor-style banner. */
  remediation?: StageRemediation | null;
}

type Visual = { icon: IconName | null; tone: string };

function statusVisual(status: StageView['status']): Visual {
  switch (status) {
    case 'running':
      return { icon: 'spinner', tone: 'running' };
    case 'passed':
      return { icon: 'check', tone: 'ok' };
    case 'failed':
      return { icon: 'close', tone: 'fail' };
    case 'skipped':
      return { icon: 'minus', tone: 'skip' };
    default:
      return { icon: null, tone: 'pending' };
  }
}

export function PipelineStepper({ stages, remediation }: Props) {
  const runningStage = STAGE_ORDER.find((name) => stages[name]?.status === 'running');

  return (
    <section className="zt-stepper" aria-label="Pipeline stages" data-testid="pipeline-stepper">
      <ol className="zt-stepper__list">
        {STAGE_ORDER.map((name) => {
          const view = stages[name] ?? { status: 'pending' };
          const visual = statusVisual(view.status);
          const showAttempt = name === 'validate' && (view.attempt ?? 0) > 1;
          return (
            <li
              key={name}
              className={`zt-stepper__stage zt-stepper__stage--${visual.tone}`}
              data-stage={name}
              data-status={view.status}
              data-testid={`stepper-stage-${name}`}
            >
              <span
                className={`zt-stepper__icon zt-stepper__icon--${visual.tone}`}
                role="img"
                aria-label={`${STAGE_LABELS[name]}: ${view.status}`}
              >
                {visual.icon ? <Icon name={visual.icon} size={14} /> : <span className="zt-stepper__dot" />}
              </span>
              <span className="zt-stepper__label">{STAGE_LABELS[name]}</span>
              {showAttempt ? (
                <span className="zt-stepper__attempt" data-testid={`stepper-attempt-${name}`}>
                  attempt {view.attempt}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <p className="zt-visually-hidden" role="status" aria-live="polite" data-testid="stepper-live">
        {runningStage ? `${STAGE_LABELS[runningStage]} running` : ''}
      </p>

      {remediation ? (
        <div className="zt-notice zt-notice--error" role="alert" data-testid="stepper-remediation">
          <Icon name="alert-triangle" size={16} />
          <div>
            <p className="zt-notice__title">
              {STAGE_LABELS[remediation.stage]} failed
            </p>
            <p className="zt-notice__text">{remediation.message}</p>
            {stages[remediation.stage]?.detail &&
            stages[remediation.stage]?.detail !== remediation.message ? (
              <pre className="zt-stepper__detail" data-testid="stepper-remediation-detail">
                {stages[remediation.stage]?.detail}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
