import { join } from "node:path";
import type { DesktopService } from "./desktop-service.js";
import { DesktopBridgeError } from "./desktop-service.js";
import type { GitService } from "../git/git-service.js";

/**
 * PipelineService — the external post-turn guarantee (spec §6.2). After an agent
 * turn touches the report/model, it runs validate → inspect → reload →
 * screenshot → commit, streaming stage events. validate auto-retries (feeding
 * the validator output back to the agent) up to a cap; inspect is non-blocking;
 * reload/screenshot failures stop with a remediation-worthy error.
 */

export type StageName = "validate" | "inspect" | "reload" | "screenshot" | "commit";
export type StageStatus = "running" | "passed" | "failed" | "skipped";

export interface StageEvent {
  stage: StageName;
  status: StageStatus;
  detail?: string;
  attempt?: number;
}

export interface StageOutput {
  ok: boolean;
  output: string;
}

export interface PipelineDeps {
  /** Structural validation (powerbi-report-author validate). */
  validate: (reportDir: string) => Promise<StageOutput>;
  /** Policy inspection (fab-inspector). Non-blocking. */
  inspect: (reportDir: string) => Promise<StageOutput>;
  desktop: DesktopService;
  git: GitService;
  /** Feed validator failure back to the agent for a corrective edit before the
   *  next validate attempt. Resolves true to retry, false to stop early. */
  onValidateFailure?: (output: string, attempt: number) => Promise<boolean>;
}

export interface PipelineOptions {
  runId: string;
  projectRoot: string;
  reportDir: string;
  /** Where screenshots for this run are written. */
  runDir: string;
  agentSummary: string;
  /** Reload the model too (auto-suggested when .SemanticModel changed). */
  reloadWithModel?: boolean;
  maxValidateAttempts?: number;
  /** When false, a validation failure does not stop the run (user-triggered
   *  "Run pipeline" still renders a preview). Defaults to true (agent loop). */
  blockOnValidate?: boolean;
  onEvent?: (event: StageEvent) => void;
  onScreenshots?: (payload: { runId: string; pages: string[] }) => void;
}

export interface PipelineResult {
  ok: boolean;
  stages: StageEvent[];
  validateAttempts: number;
  screenshots?: { runId: string; pages: string[] };
  commitSha: string | null;
  /** Set when reload/screenshot failed — drives the remediation banner. */
  remediation?: { stage: StageName; message: string };
}

export class PipelineService {
  constructor(private readonly deps: PipelineDeps) {}

  async run(options: PipelineOptions): Promise<PipelineResult> {
    const stages: StageEvent[] = [];
    const emit = (event: StageEvent) => {
      stages.push(event);
      options.onEvent?.(event);
    };
    const maxAttempts = options.maxValidateAttempts ?? 3;

    // --- validate (auto-retry with agent feedback) ---
    let validateOk = false;
    let attempts = 0;
    while (attempts < maxAttempts) {
      attempts += 1;
      emit({ stage: "validate", status: "running", attempt: attempts });
      const result = await this.deps.validate(options.reportDir);
      if (result.ok) {
        emit({ stage: "validate", status: "passed", attempt: attempts });
        validateOk = true;
        break;
      }
      emit({ stage: "validate", status: "failed", attempt: attempts, detail: result.output });
      if (attempts < maxAttempts) {
        const retry = (await this.deps.onValidateFailure?.(result.output, attempts)) ?? false;
        if (!retry) break;
      }
    }
    // A user-triggered "Run pipeline" (blockOnValidate=false) should still render
    // a preview even when the existing report has validation issues — the
    // validate result is surfaced as a failed stage, but reload/screenshot run
    // anyway. The agent loop keeps validate blocking (default true).
    if (!validateOk && (options.blockOnValidate ?? true)) {
      return { ok: false, stages, validateAttempts: attempts, commitSha: null };
    }

    // --- inspect (non-blocking) ---
    emit({ stage: "inspect", status: "running" });
    try {
      const inspect = await this.deps.inspect(options.reportDir);
      emit({ stage: "inspect", status: inspect.ok ? "passed" : "failed", detail: inspect.output });
    } catch (err) {
      emit({ stage: "inspect", status: "failed", detail: String((err as Error)?.message ?? err) });
    }

    // --- reload ---
    emit({ stage: "reload", status: "running" });
    try {
      await this.deps.desktop.reload({ reportOnly: !options.reloadWithModel });
      emit({ stage: "reload", status: "passed" });
    } catch (err) {
      const message = err instanceof DesktopBridgeError ? err.message : String((err as Error)?.message ?? err);
      emit({ stage: "reload", status: "failed", detail: message });
      return { ok: false, stages, validateAttempts: attempts, commitSha: null, remediation: { stage: "reload", message } };
    }

    // --- screenshot ---
    emit({ stage: "screenshot", status: "running" });
    let screenshots: { runId: string; pages: string[] } | undefined;
    try {
      const pages = await this.deps.desktop.screenshotAll(options.runDir);
      screenshots = { runId: options.runId, pages };
      emit({ stage: "screenshot", status: "passed", detail: `${pages.length} page(s)` });
      options.onScreenshots?.(screenshots);
    } catch (err) {
      const message = err instanceof DesktopBridgeError ? err.message : String((err as Error)?.message ?? err);
      emit({ stage: "screenshot", status: "failed", detail: message });
      return { ok: false, stages, validateAttempts: attempts, commitSha: null, remediation: { stage: "screenshot", message } };
    }

    // --- commit ---
    emit({ stage: "commit", status: "running" });
    const commitSha = await this.deps.git.commitAll(
      options.projectRoot,
      `${options.agentSummary} (session ${options.runId})`,
    );
    emit({ stage: "commit", status: commitSha ? "passed" : "skipped", detail: commitSha ?? "nothing to commit" });

    return { ok: true, stages, validateAttempts: attempts, screenshots, commitSha };
  }
}

/** Stable path the agent reads for its visual-review step (§6.3): a copy of the
 *  newest run's screenshots at `.zerotwo/screenshots/latest/`. */
export function latestScreenshotsDir(projectRoot: string): string {
  return join(projectRoot, ".zerotwo", "screenshots", "latest");
}
