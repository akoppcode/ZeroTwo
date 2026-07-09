import { runCli } from "../cli-runner.js";

/**
 * DesktopService — wraps the Power BI Desktop bridge CLI (spec §6.4):
 * status (instances + PIDs), open, reload (report-only by default),
 * screenshot-all, and manifest (cached capability list). Runner is injectable
 * so tests drive the mock bridge; PID handling for the instance picker lives in
 * `status()`.
 */

export interface DesktopInstance {
  pid: number;
  title: string;
}

export interface DesktopStatus {
  connected: boolean;
  instances: DesktopInstance[];
}

export type CliRunner = (
  bin: string,
  argv: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: CliRunner = runCli;

export class DesktopBridgeError extends Error {
  constructor(
    message: string,
    readonly stage: "status" | "open" | "reload" | "screenshot" | "manifest",
  ) {
    super(message);
    this.name = "DesktopBridgeError";
  }
}

export class DesktopService {
  constructor(
    private readonly runner: CliRunner = defaultRunner,
    private readonly bin: string = "powerbi-desktop",
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.runner(this.bin, argv, this.env ? { env: this.env } : undefined);
  }

  /** Bridge connection state + the running Desktop instances (for the picker). */
  async status(): Promise<DesktopStatus> {
    const res = await this.run(["status"]);
    const text = res.stdout.trim();
    if (res.code !== 0) throw new DesktopBridgeError(res.stderr.trim() || "bridge status failed", "status");
    if (text.startsWith("not_connected")) return { connected: false, instances: [] };
    try {
      const parsed = JSON.parse(text);
      const instances: DesktopInstance[] = Array.isArray(parsed.instances)
        ? parsed.instances.map((i: any) => ({ pid: Number(i.pid), title: String(i.title ?? "") }))
        : [];
      return { connected: true, instances };
    } catch {
      // Legacy human-readable form ("connected: ...") — treat as one instance.
      return { connected: /^connected/i.test(text), instances: [] };
    }
  }

  async open(pbipPath: string): Promise<void> {
    const res = await this.run(["open", pbipPath]);
    if (res.code !== 0) throw new DesktopBridgeError(res.stderr.trim() || "open failed", "open");
  }

  async reload(options: { reportOnly?: boolean } = {}): Promise<void> {
    const reportOnly = options.reportOnly ?? true;
    const res = await this.run(reportOnly ? ["reload", "--report-only"] : ["reload"]);
    if (res.code !== 0) throw new DesktopBridgeError(res.stderr.trim() || "reload failed", "reload");
  }

  /** Capture every page to `outDir`; returns the captured page names. */
  async screenshotAll(outDir: string): Promise<string[]> {
    const res = await this.run(["screenshot-all", "--out", outDir]);
    if (res.code !== 0) throw new DesktopBridgeError(res.stderr.trim() || "screenshot failed", "screenshot");
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed.pages) ? parsed.pages.map(String) : [];
    } catch {
      return [];
    }
  }

  /** Cached-on-daemon-start capability list; features degrade if a method is gone. */
  async manifest(): Promise<string[]> {
    const res = await this.run(["manifest"]);
    if (res.code !== 0) throw new DesktopBridgeError(res.stderr.trim() || "manifest failed", "manifest");
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed.methods) ? parsed.methods.map(String) : [];
    } catch {
      return [];
    }
  }
}
