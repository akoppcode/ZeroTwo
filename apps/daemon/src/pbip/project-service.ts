import { basename } from "node:path";
import { GitService } from "../git/git-service.js";
import { inspectPbip, type PbipInspectResult } from "./pbip-inspect.js";
import { scaffoldPbip } from "./pbip-scaffold.js";

/**
 * ProjectService — attach an existing PBIP or scaffold a new one (spec §4.4/§4.5).
 * Orchestrates inspection + the git safety net; persistence of the resulting
 * record (SQLite projects row, §4.1) and the chokidar attach-wizard watcher are
 * wired at the route layer.
 */

export type ProjectAgent = "claude" | "copilot";
export type ProjectKind = "attached" | "scaffolded";

export interface ZeroTwoProject {
  name: string;
  path: string;
  kind: ProjectKind;
  agent: ProjectAgent;
  pbipFile: string | null;
  reportDirName: string;
  hasSemanticModel: boolean;
  semanticModelTmdl: boolean;
  pageCount: number;
  visualCount: number;
  /** The baseline commit made when the project was registered. */
  baselineSha: string | null;
}

export type AttachOutcome =
  | { ok: true; project: ZeroTwoProject; inspect: Extract<PbipInspectResult, { ok: true }> }
  | { ok: false; code: string; message: string };

export interface ProjectServiceOptions {
  git?: GitService;
}

export class ProjectService {
  private readonly git: GitService;

  constructor(options: ProjectServiceOptions = {}) {
    this.git = options.git ?? new GitService();
  }

  /** Attach an existing PBIP folder: inspect, init the repo + baseline commit,
   *  and return the project record. Rejects legacy / malformed projects. */
  async attach(root: string, agent: ProjectAgent, kind: ProjectKind = "attached"): Promise<AttachOutcome> {
    const inspect = await inspectPbip(root);
    if (!inspect.ok) {
      return { ok: false, code: inspect.code, message: inspect.message };
    }

    await this.git.ensureRepo(root);
    const importedName = inspect.pbipFile?.replace(/\.pbip$/i, "") ?? inspect.report.reportDirName.replace(/\.Report$/i, "");
    const message =
      kind === "scaffolded"
        ? `chore: scaffold ${basename(root)}`
        : `chore: initial import of ${inspect.pbipFile ?? importedName}`;
    const baselineSha = await this.git.commitAll(root, message);

    const pageCount = inspect.report.pages.length;
    const visualCount = inspect.report.pages.reduce((n, p) => n + p.visuals.length, 0);
    const project: ZeroTwoProject = {
      name: importedName,
      path: root,
      kind,
      agent,
      pbipFile: inspect.pbipFile,
      reportDirName: inspect.report.reportDirName,
      hasSemanticModel: inspect.semanticModel != null,
      semanticModelTmdl: inspect.semanticModel?.tmdl ?? false,
      pageCount,
      visualCount,
      baselineSha,
    };
    return { ok: true, project, inspect };
  }

  /** Scaffold a new PBIR-format PBIP under `root` and attach it. */
  async scaffold(root: string, reportName: string, agent: ProjectAgent): Promise<AttachOutcome> {
    await scaffoldPbip(root, reportName);
    return this.attach(root, agent, "scaffolded");
  }
}
