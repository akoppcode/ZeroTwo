import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * GitService — the project safety net (spec §11, §6.1). Drives the git CLI
 * directly (programmatic, no GUI tools): auto-init on attach/scaffold, a
 * baseline commit before every agent session, an auto-commit after every
 * accepted iteration, plus history + restore for the History panel. Every
 * repo mutation is scoped to the project path.
 */

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authoredAt: string;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const IDENTITY_ARGS = [
  "-c",
  "user.name=Zero Two",
  "-c",
  "user.email=zerotwo@local",
  "-c",
  "commit.gpgsign=false",
];

/** The .gitignore Zero Two writes into a managed project (spec §4.2/§4.3). */
export const ZERO_TWO_GITIGNORE = `# Power BI Desktop cache / per-user files
*.pbix
.pbi/
*.Report/.pbi/
*.SemanticModel/.pbi/

# Zero Two local state (committed: briefs/, zerotwo.json)
.zerotwo/screenshots/
.zerotwo/sessions/
`;

export class GitService {
  constructor(private readonly runner: (args: string[], cwd: string) => Promise<GitRunResult> = defaultGitRunner) {}

  private run(cwd: string, args: string[]): Promise<GitRunResult> {
    return this.runner(args, cwd);
  }

  async isRepo(projectPath: string): Promise<boolean> {
    const res = await this.run(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  /** Init the repo if absent and write the Zero Two .gitignore. Idempotent. */
  async ensureRepo(projectPath: string): Promise<{ initialized: boolean }> {
    const already = await this.isRepo(projectPath);
    if (!already) {
      const res = await this.run(projectPath, ["init"]);
      if (res.code !== 0) throw new Error(`git init failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    await writeFile(join(projectPath, ".gitignore"), ZERO_TWO_GITIGNORE, "utf8").catch(() => {});
    return { initialized: !already };
  }

  /** True when the working tree has staged or unstaged changes. */
  async hasChanges(projectPath: string): Promise<boolean> {
    const res = await this.run(projectPath, ["status", "--porcelain"]);
    return res.stdout.trim().length > 0;
  }

  /** Stage everything and commit; returns the new commit sha, or null when
   *  there was nothing to commit (clean tree). */
  async commitAll(projectPath: string, message: string): Promise<string | null> {
    await this.run(projectPath, ["add", "-A"]);
    // `diff --cached --quiet` exits 0 when nothing is staged relative to HEAD.
    const staged = await this.run(projectPath, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return null;
    const res = await this.run(projectPath, [...IDENTITY_ARGS, "commit", "-m", message, "--allow-empty-message"]);
    if (res.code !== 0) {
      if (/nothing to commit/i.test(res.stdout + res.stderr)) return null;
      throw new Error(`git commit failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return this.headSha(projectPath);
  }

  async headSha(projectPath: string): Promise<string | null> {
    const res = await this.run(projectPath, ["rev-parse", "HEAD"]);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  /** Commit history for the History panel (newest first). */
  async log(projectPath: string, limit = 100): Promise<GitCommit[]> {
    const sep = "";
    const res = await this.run(projectPath, [
      "log",
      `--max-count=${limit}`,
      `--pretty=format:%H${sep}%h${sep}%s${sep}%aI`,
    ]);
    if (res.code !== 0) return [];
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha = "", shortSha = "", subject = "", authoredAt = ""] = line.split(sep);
        return { sha, shortSha, subject, authoredAt };
      });
  }

  /** Restore to a commit (hard reset) after stashing any local changes as a
   *  safety net (spec §11 "Restore (hard reset with confirm + safety stash)"). */
  async restore(projectPath: string, sha: string): Promise<void> {
    if (await this.hasChanges(projectPath)) {
      await this.run(projectPath, [...IDENTITY_ARGS, "stash", "push", "-u", "-m", `zerotwo-restore-safety-${Date.now()}`]);
    }
    const res = await this.run(projectPath, ["reset", "--hard", sha]);
    if (res.code !== 0) throw new Error(`git restore failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

const defaultGitRunner = (args: string[], cwd: string): Promise<GitRunResult> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
