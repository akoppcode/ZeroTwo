/**
 * Phase 0 acceptance smoke test: the Zero Two daemon boots and serves an
 * empty project list on a clean data dir. Electron can't run headless in CI,
 * and the renderer only proxies the daemon, so booting the daemon and hitting
 * its HTTP surface is the meaningful end-to-end boot check.
 *
 * Spawns `apps/daemon/dist/cli.js daemon start --headless` against a throwaway
 * OD_DATA_DIR + a fixed OD_PORT, polls /api/health, asserts GET /api/projects
 * returns `{ projects: [] }`, then tears the daemon down. Exits non-zero on any
 * failure (daemon output is inherited into this process's stdio for debugging).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const cliEntry = join(repoRoot, 'apps', 'daemon', 'dist', 'cli.js');
const port = 17456;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'zerotwo-smoke-'));

const child = spawn(process.execPath, [cliEntry, 'daemon', 'start', '--headless'], {
  cwd: repoRoot,
  env: { ...process.env, OD_PORT: String(port), OD_DATA_DIR: dataDir },
  // Inherit so daemon logs land in the CI output and there are no JS-side pipe
  // handles to race with process teardown on Windows.
  stdio: ['ignore', 'inherit', 'inherit'],
});

let childExited = false;
const exited = new Promise<void>((r) => child.on('exit', () => { childExited = true; r(); }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let finished = false;
async function finish(code: number, message: string): Promise<void> {
  if (finished) return;
  finished = true;
  process.stdout.write(`daemon-boot-smoke: ${code === 0 ? 'OK' : 'FAIL'} — ${message}\n`);
  // Kill the daemon and wait for its actual exit. Do NOT call process.exit():
  // exiting while the child_process handle is still closing aborts libuv on
  // Windows ("UV_HANDLE_CLOSING" assertion, exit 9). Instead set exitCode and
  // let the event loop drain — once the killed child's handle closes there is
  // nothing left to keep the loop alive, so Node exits cleanly with this code.
  process.exitCode = code;
  if (!childExited) {
    child.kill();
    await Promise.race([exited, sleep(5_000)]);
  }
  // Windows keeps the SQLite file locked until the daemon fully exits, so a
  // prompt rmSync can race with it (EPERM). The data dir is a throwaway, so a
  // failed cleanup must never affect the result.
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignore — leftover temp dir is harmless
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (childExited) { await finish(1, 'daemon process died before becoming healthy'); return; }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  await finish(1, 'daemon did not report healthy within 60s');
}

async function assertEmptyProjects(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/projects`);
  if (!res.ok) { await finish(1, `GET /api/projects returned HTTP ${res.status}`); return; }
  const body = (await res.json()) as { projects?: unknown };
  if (!Array.isArray(body.projects)) {
    await finish(1, `GET /api/projects did not return a projects array; got ${JSON.stringify(body)}`);
    return;
  }
  if (body.projects.length !== 0) {
    await finish(1, `fresh daemon must serve an empty project list; got ${body.projects.length} project(s)`);
  }
}

await waitForHealth();
await assertEmptyProjects();
await finish(0, 'daemon booted and served an empty project list');
