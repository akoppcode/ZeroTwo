// Runtime probes for OS-level filesystem capabilities that some security tests
// depend on. Windows (run via cmd.exe on CI) cannot create symlinks without
// SeCreateSymbolicLinkPrivilege / Developer Mode, and does not carry a POSIX
// exec bit. Tests that exercise KEPT symlink/exec-bit behaviour gate on these
// probes so they RUN on POSIX and are SKIPPED where the OS op is impossible —
// never mocked away, never weakened.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** True when the current process can create a symlink on the temp filesystem. */
export const SYMLINK_SUPPORTED = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'od-symlink-probe-'));
    const target = join(dir, 'target');
    writeFileSync(target, 'x');
    symlinkSync(target, join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

/**
 * True when `chmod(file, 0o000)` actually makes the file unreadable to the
 * current process. Windows ignores POSIX read bits for the owner (and root on
 * POSIX bypasses them), so a "made this file unreadable" failure-injection
 * cannot be exercised there.
 */
export const READ_BLOCKED_BY_CHMOD = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'od-chmod-read-probe-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'x');
    chmodSync(file, 0o000);
    try {
      readFileSync(file);
      return false;
    } catch {
      return true;
    } finally {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best-effort restore */
      }
    }
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

/**
 * True when `chmod(dir, 0o555)` actually prevents creating files inside the
 * directory. Windows does not enforce POSIX directory write bits (nor does root
 * on POSIX), so a "read-only directory" failure-injection cannot be exercised
 * there.
 */
export const DIR_READONLY_ENFORCED = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'od-rodir-probe-'));
    const sub = join(dir, 'ro');
    mkdirSync(sub);
    chmodSync(sub, 0o555);
    try {
      writeFileSync(join(sub, 'blocked'), 'x');
      return false;
    } catch {
      return true;
    } finally {
      try {
        chmodSync(sub, 0o755);
      } catch {
        /* best-effort restore */
      }
    }
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

/**
 * True when a `#!/bin/sh` script can be spawned directly (its shebang is
 * honoured by the OS). Windows cannot execute shell scripts via CreateProcess
 * (spawn fails with EFTYPE), and there is no shell-less way to fake such a
 * binary there — a `.cmd`/`.bat` shim needs `shell:true`, which the production
 * spawn paths under test deliberately do not use. Tests whose fixtures hand a
 * shell-script "executable" to a shell-less spawn (fake `git`, html-ppt's
 * render.sh) gate on this so they RUN on POSIX and SKIP where the OS op is
 * impossible.
 */
export const POSIX_SHELL_SCRIPT_SUPPORTED = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'od-shscript-probe-'));
    const script = join(dir, 'probe.sh');
    writeFileSync(script, '#!/bin/sh\nexit 0\n');
    chmodSync(script, 0o755);
    const result = spawnSync(script, [], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

/** True when chmod's POSIX exec bit survives a stat() on the temp filesystem. */
export const EXEC_BIT_SUPPORTED = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'od-execbit-probe-'));
    const file = join(dir, 'script');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    return (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();
