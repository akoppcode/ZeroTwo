import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the spawnable path for a fake agent CLI written by
 * {@link writeFakeAgentBin}, without writing anything. Use this when a test
 * knows a fake agent's base name and needs the value to point CLAUDE_BIN /
 * COPILOT_BIN at (Windows appends the `.cmd` shim suffix, POSIX does not).
 */
export function fakeAgentBinPath(dir: string, name: string): string {
  return join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
}

/**
 * Write a Node-backed fake agent CLI and return the path to spawn
 * (the value to point CLAUDE_BIN / COPILOT_BIN at).
 *
 * POSIX: a single shebang script marked executable (`chmod +x`).
 * Windows: a `<name>.js` holding the body plus a `<name>.cmd` shim that runs
 * `node "<name>.js" %*`, because Windows cannot spawn a shebang file directly
 * (no exec bit, cmd.exe won't route it through node). The daemon's launch path
 * knows how to invoke a `.cmd` shim through cmd.exe.
 *
 * @param dir       directory to write the fake CLI into (usually a temp dir)
 * @param name      base name of the CLI (e.g. 'claude', 'copilot')
 * @param nodeBody  the JS body to run, WITHOUT the `#!/usr/bin/env node` line
 * @returns the absolute path to hand to CLAUDE_BIN / COPILOT_BIN
 */
export function writeFakeAgentBin(dir: string, name: string, nodeBody: string): string {
  if (process.platform === 'win32') {
    const jsPath = join(dir, `${name}.js`);
    const cmdPath = fakeAgentBinPath(dir, name);
    writeFileSync(jsPath, nodeBody, 'utf8');
    writeFileSync(cmdPath, `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const binPath = fakeAgentBinPath(dir, name);
  writeFileSync(binPath, `#!/usr/bin/env node\n${nodeBody}`, 'utf8');
  chmodSync(binPath, 0o755);
  return binPath;
}
