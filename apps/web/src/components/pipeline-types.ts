// Shared types for the Phase 4 pipeline UI (design spec §6.2 stepper + §7
// preview). Mirrors the daemon's pipeline SSE contract (apps/daemon/src/
// desktop/pipeline-service.ts) and the report inventory returned by the
// attach / scaffold routes (apps/daemon/src/pbip/pbip-inspect.ts:PbipPage).

/** Post-turn pipeline stages, in run order (spec §6.2). */
export type StageName = 'validate' | 'inspect' | 'reload' | 'screenshot' | 'commit';

/** Terminal / in-flight status a stage reports over SSE. */
export type StageStatus = 'running' | 'passed' | 'failed' | 'skipped';

/** A `pipeline:stage` SSE frame. */
export interface StageEvent {
  stage: StageName;
  status: StageStatus;
  detail?: string;
  attempt?: number;
}

/** Per-stage view state the stepper renders; 'pending' = not yet reached. */
export interface StageView {
  status: StageStatus | 'pending';
  detail?: string;
  attempt?: number;
}

/** Remediation surfaced when reload / screenshot fails (spec §6.2 Doctor banner). */
export interface StageRemediation {
  stage: StageName;
  message: string;
}

/** `screenshots:updated` SSE frame — which page PNGs exist for a run. */
export interface ScreenshotsPayload {
  runId: string;
  pages: string[];
}

/** `pipeline:done` SSE frame. */
export interface PipelineDone {
  ok: boolean;
  stages?: StageEvent[];
  screenshots?: ScreenshotsPayload;
  remediation?: StageRemediation;
}

/** A report page from the attach / scaffold inventory (`report.pages`). */
export interface ReportPage {
  /** Page folder name (`definition/pages/<name>/`) — the stable id and PNG basename. */
  name: string;
  displayName: string;
  hidden: boolean;
  width: number | null;
  height: number | null;
  visuals: unknown[];
}

/** The five stages in canonical order. */
export const STAGE_ORDER: StageName[] = ['validate', 'inspect', 'reload', 'screenshot', 'commit'];

export const STAGE_LABELS: Record<StageName, string> = {
  validate: 'Validate',
  inspect: 'Inspect',
  reload: 'Reload',
  screenshot: 'Screenshot',
  commit: 'Commit',
};
