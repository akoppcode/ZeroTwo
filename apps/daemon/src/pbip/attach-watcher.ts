import chokidar, { type FSWatcher } from "chokidar";
import { inspectPbip, type PbipInspectResult } from "./pbip-inspect.js";

/**
 * Attach-wizard watcher (spec §4.4). While the user does File → Save As → .pbip
 * in Power BI Desktop, Zero Two watches the destination folder; once a valid
 * PBIR project appears AND file writes settle (debounce), it resolves so the
 * wizard can auto-inspect + create the project. Also handles the error variant:
 * a legacy (PBIR-legacy) save resolves with the rejection so the wizard can loop
 * back with enhanced-format guidance.
 */

export interface WatchForPbipOptions {
  /** Quiet period after the last filesystem event before inspecting (default 2s). */
  debounceMs?: number;
  /** Give up after this long with no valid project (default 10 min). */
  timeoutMs?: number;
  /** Abort the watch (user cancelled the wizard). */
  signal?: AbortSignal;
}

export type WatchForPbipResult =
  | { status: "found"; root: string; inspect: Extract<PbipInspectResult, { ok: true }> }
  | { status: "legacy"; root: string; message: string }
  | { status: "timeout" }
  | { status: "aborted" };

export function watchForPbip(destFolder: string, options: WatchForPbipOptions = {}): Promise<WatchForPbipResult> {
  const debounceMs = options.debounceMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<WatchForPbipResult>((resolve) => {
    let settled = false;
    let debounce: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let watcher: FSWatcher | null = null;

    const finish = (result: WatchForPbipResult) => {
      if (settled) return;
      settled = true;
      if (debounce) clearTimeout(debounce);
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      void watcher?.close();
      resolve(result);
    };

    const onAbort = () => finish({ status: "aborted" });

    // Inspect after writes settle; a valid PBIR ends the watch, a legacy save
    // surfaces the rejection, anything else keeps waiting.
    const inspectNow = async () => {
      if (settled) return;
      const result = await inspectPbip(destFolder);
      if (result.ok) {
        finish({ status: "found", root: destFolder, inspect: result });
      } else if (result.code === "pbir-legacy") {
        finish({ status: "legacy", root: destFolder, message: result.message });
      }
      // no-report / unreadable: the save is still in progress — keep watching.
    };

    const bump = () => {
      if (settled) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void inspectNow(), debounceMs);
    };

    if (options.signal?.aborted) return finish({ status: "aborted" });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

    watcher = chokidar.watch(destFolder, { ignoreInitial: false, depth: 6 });
    watcher.on("add", bump).on("addDir", bump).on("change", bump);
    // Fire once shortly after startup in case the project already exists.
    watcher.on("ready", bump);
  });
}
