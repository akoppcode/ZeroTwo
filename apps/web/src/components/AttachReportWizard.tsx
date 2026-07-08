// Attach report wizard (design spec §3.2) — the flagship onboarding flow.
//
// A four-step stepper: Source → Convert → Detected → Ready. The user performs
// one manual action (Save As .pbip in Power BI Desktop); everything around it is
// automated. The Convert step drives the daemon's SSE watcher
// (POST /api/projects/attach/watch) so the wizard auto-advances the moment a
// valid PBIR project settles on disk. A legacy (PBIR-legacy) save loops back
// with enhanced-format guidance.
//
// Design decision: the daemon attaches-on-detect and needs the agent in the
// watch request body, so agent selection lives on the Source step (setup)
// rather than the literal spec position on Ready. Ready shows it as a summary.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ProvisioningPanel } from './ProvisioningPanel';
import { ZeroTwoAgentPicker, type ZeroTwoAgent } from './ZeroTwoAgentPicker';
import { ZeroTwoWizardModal } from './ZeroTwoWizardModal';

type AttachStep = 'source' | 'convert' | 'detected' | 'ready';
type WatchState = 'watching' | 'legacy' | 'timeout' | 'error';

interface DetectedProject {
  project: {
    id: string;
    name: string;
    agent: string;
    pageCount: number;
    visualCount: number;
    hasSemanticModel: boolean;
    reportDirName: string;
  };
  report: { reportDirName: string; pages: unknown[] };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the attached project id once the user opens the workspace. */
  onOpened?: (projectId: string) => void;
  defaultAgent?: ZeroTwoAgent;
}

const STEP_LABELS: Array<{ id: AttachStep; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'convert', label: 'Convert' },
  { id: 'detected', label: 'Detected' },
  { id: 'ready', label: 'Ready' },
];

/** Read the daemon SSE stream, invoking `onEvent` for each `event:`/`data:` frame. */
async function readWatchStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        try {
          onEvent(event, JSON.parse(dataLines.join('\n')) as Record<string, unknown>);
        } catch {
          // Ignore keepalive / non-JSON frames.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be blocked; the path stays visible and selectable.
    }
  }, [value]);
  return (
    <button
      type="button"
      className="zt-copy"
      onClick={onCopy}
      aria-label={copied ? 'Copied to clipboard' : `Copy path: ${value}`}
      data-testid="attach-copy-dest"
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function Stepper({ current }: { current: AttachStep }) {
  const currentIndex = STEP_LABELS.findIndex((s) => s.id === current);
  return (
    <ol className="zt-stepper" aria-label="Progress">
      {STEP_LABELS.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
        return (
          <li key={step.id} className={`zt-stepper__step zt-stepper__step--${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <span className="zt-stepper__dot">{state === 'done' ? <Icon name="check" size={11} /> : index + 1}</span>
            <span className="zt-stepper__label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function AttachReportWizard({ open, onClose, onOpened, defaultAgent = 'claude' }: Props) {
  const [step, setStep] = useState<AttachStep>('source');
  const [agent, setAgent] = useState<ZeroTwoAgent>(defaultAgent);
  const [pbixName, setPbixName] = useState<string | null>(null);
  const [destFolder, setDestFolder] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [watchState, setWatchState] = useState<WatchState>('watching');
  const [watchMessage, setWatchMessage] = useState('');
  const [watchNonce, setWatchNonce] = useState(0);
  const [detected, setDetected] = useState<DetectedProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setStep('source');
    setAgent(defaultAgent);
    setPbixName(null);
    setDestFolder('');
    setFolderPath('');
    setWatchState('watching');
    setWatchMessage('');
    setDetected(null);
    setBusy(false);
    setActionError(null);
  }, [defaultAgent]);

  const close = useCallback(() => {
    onClose();
    // Reset after the close transition so the next open starts fresh.
    setTimeout(reset, 200);
  }, [onClose, reset]);

  // Drive the watch stream while on the Convert step. The AbortController wires
  // the request close so cancelling the wizard stops the daemon watcher.
  useEffect(() => {
    if (!open || step !== 'convert') return;
    const controller = new AbortController();
    let cancelled = false;
    setWatchState('watching');
    setWatchMessage('');
    (async () => {
      try {
        const res = await fetch('/api/projects/attach/watch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destFolder, agent }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          if (!cancelled) {
            setWatchState('error');
            setWatchMessage(`Could not start the folder watch (HTTP ${res.status}).`);
          }
          return;
        }
        await readWatchStream(res.body, (event, data) => {
          if (cancelled) return;
          if (event === 'detected') {
            setDetected(data as unknown as DetectedProject);
            setStep('detected');
          } else if (event === 'legacy') {
            setWatchState('legacy');
            setWatchMessage(typeof data.message === 'string' ? data.message : 'Legacy report format detected.');
          } else if (event === 'timeout') {
            setWatchState('timeout');
          } else if (event === 'error') {
            setWatchState('error');
            setWatchMessage(typeof data.message === 'string' ? data.message : 'The watch failed.');
          }
        });
      } catch (err) {
        if (!cancelled && !controller.signal.aborted) {
          setWatchState('error');
          setWatchMessage(err instanceof Error ? err.message : 'The watch failed.');
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, step, watchNonce, destFolder, agent]);

  // Detected step auto-advances to Ready after a beat (spec §3.2 step 3).
  useEffect(() => {
    if (step !== 'detected') return;
    const timer = setTimeout(() => setStep('ready'), 1600);
    return () => clearTimeout(timer);
  }, [step]);

  const onPickPbix = useCallback((file: File | null | undefined) => {
    if (!file) return;
    setPbixName(file.name);
    // TODO(Phase 4): auto-launch Power BI Desktop with this .pbix via the
    // Desktop bridge. For now the user opens it manually and Saves As .pbip.
  }, []);

  const useExistingFolder = useCallback(() => {
    if (!folderPath.trim()) return;
    setActionError(null);
    setStep('ready');
  }, [folderPath]);

  const openWorkspace = useCallback(async () => {
    // pbix/watch flow already attached the project on detection.
    if (detected) {
      onOpened?.(detected.project.id);
      close();
      return;
    }
    // Existing-folder flow attaches now with the selected agent.
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch('/api/projects/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath.trim(), agent }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as { project: { id: string } };
        onOpened?.(body.project.id);
        close();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      if (res.status === 422 && body?.error?.code === 'pbir-legacy') {
        setActionError(
          body.error.message ??
            'This report uses the legacy format. Enable the PBIR enhanced report format in Power BI Desktop and re-save.',
        );
      } else {
        setActionError(body?.error?.message ?? `Attach failed (HTTP ${res.status}).`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Attach failed.');
    } finally {
      setBusy(false);
    }
  }, [detected, folderPath, agent, onOpened, close]);

  const watchAgain = useCallback(() => {
    setWatchState('watching');
    setWatchMessage('');
    setWatchNonce((n) => n + 1);
  }, []);

  const canStartWatch = pbixName != null && destFolder.trim().length > 0;

  return (
    <ZeroTwoWizardModal
      open={open}
      title="Attach a report"
      subtitle="Bring a Power BI report into Zero Two as a source-controlled PBIP project."
      onClose={close}
      headerAside={<Stepper current={step} />}
      testId="attach-wizard"
    >
      {step === 'source' ? (
        <div className="zt-step" data-testid="attach-step-source">
          <div
            className={`zt-dropzone${dragOver ? ' is-drag' : ''}${pbixName ? ' is-filled' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              onPickPbix(e.dataTransfer.files?.[0]);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            aria-label="Drop a .pbix file or click to browse"
            data-testid="attach-dropzone"
          >
            <Icon name={pbixName ? 'file-code' : 'upload'} size={22} />
            {pbixName ? (
              <p className="zt-dropzone__file">{pbixName}</p>
            ) : (
              <>
                <p className="zt-dropzone__title">Drop a .pbix file</p>
                <p className="zt-dropzone__hint">or click to browse</p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pbix"
              className="zt-visually-hidden"
              onChange={(e) => onPickPbix(e.target.files?.[0])}
              data-testid="attach-file-input"
            />
          </div>

          <label className="zt-field">
            <span className="zt-field__label">Destination folder</span>
            <input
              type="text"
              className="zt-input"
              placeholder="C:\PowerBIProjects\my-report"
              value={destFolder}
              onChange={(e) => setDestFolder(e.target.value)}
              data-testid="attach-dest-input"
            />
            <span className="zt-field__hint">Where you will Save As the .pbip. Zero Two watches this folder.</span>
          </label>

          <label className="zt-field">
            <span className="zt-field__label">Agent</span>
            <ZeroTwoAgentPicker value={agent} onChange={setAgent} idBase="attach-agent" />
          </label>

          <button
            type="button"
            className="zt-btn zt-btn--primary"
            disabled={!canStartWatch}
            onClick={() => setStep('convert')}
            data-testid="attach-start-watch"
          >
            Start watching
          </button>

          <div className="zt-or" role="separator">
            <span>or</span>
          </div>

          <label className="zt-field">
            <span className="zt-field__label">Select an existing PBIP folder</span>
            <div className="zt-field__row">
              <input
                type="text"
                className="zt-input"
                placeholder="C:\PowerBIProjects\existing-report"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                data-testid="attach-existing-input"
              />
              <button
                type="button"
                className="zt-btn"
                disabled={!folderPath.trim()}
                onClick={useExistingFolder}
                data-testid="attach-use-folder"
              >
                Use this folder
              </button>
            </div>
            <span className="zt-field__hint">Already have a PBIP on disk? Skip the conversion.</span>
          </label>
        </div>
      ) : null}

      {step === 'convert' ? (
        <div className="zt-step" data-testid="attach-step-convert">
          <ol className="zt-checklist">
            <li>
              <Icon name="external-link" size={15} />
              <span>
                In Power BI Desktop: <strong>File → Save As → Power BI project (.pbip)</strong>.
              </span>
            </li>
            <li>
              <Icon name="folder" size={15} />
              <span>Choose the destination folder shown below.</span>
            </li>
          </ol>

          <div className="zt-path-card">
            <span className="zt-path-card__label">Destination</span>
            <code className="zt-path-card__value">{destFolder}</code>
            <CopyButton value={destFolder} />
          </div>

          {watchState === 'watching' ? (
            <div className="zt-activity" role="status" data-testid="attach-watching">
              <Icon name="spinner" size={16} />
              <span>Watching folder… waiting for the project to appear.</span>
            </div>
          ) : null}

          {watchState === 'legacy' ? (
            <div className="zt-notice zt-notice--warning" role="alert" data-testid="attach-legacy">
              <Icon name="alert-triangle" size={16} />
              <div>
                <p className="zt-notice__title">Legacy report format detected</p>
                <p className="zt-notice__text">{watchMessage}</p>
                <button type="button" className="zt-btn" onClick={watchAgain} data-testid="attach-watch-again">
                  Watch again
                </button>
              </div>
            </div>
          ) : null}

          {watchState === 'timeout' ? (
            <div className="zt-notice" role="status" data-testid="attach-timeout">
              <Icon name="history" size={16} />
              <div>
                <p className="zt-notice__title">Still waiting</p>
                <p className="zt-notice__text">No project appeared yet. Save As in Power BI Desktop, then keep watching.</p>
                <button type="button" className="zt-btn" onClick={watchAgain} data-testid="attach-watch-again">
                  Watch again
                </button>
              </div>
            </div>
          ) : null}

          {watchState === 'error' ? (
            <div className="zt-notice zt-notice--error" role="alert" data-testid="attach-error">
              <Icon name="close" size={16} />
              <div>
                <p className="zt-notice__title">Watch failed</p>
                <p className="zt-notice__text">{watchMessage}</p>
                <button type="button" className="zt-btn" onClick={watchAgain}>
                  Try again
                </button>
              </div>
            </div>
          ) : null}

          <button type="button" className="zt-btn zt-btn--ghost" onClick={() => setStep('source')}>
            Back
          </button>
        </div>
      ) : null}

      {step === 'detected' && detected ? (
        <div className="zt-step" data-testid="attach-step-detected">
          <div className="zt-detected">
            <span className="zt-detected__pulse">
              <Icon name="check" size={20} />
            </span>
            <p className="zt-detected__title">Project detected</p>
            <dl className="zt-detected__facts">
              <div>
                <dt>Report</dt>
                <dd>{detected.project.name}</dd>
              </div>
              <div>
                <dt>Pages</dt>
                <dd>{detected.project.pageCount}</dd>
              </div>
              <div>
                <dt>Semantic model</dt>
                <dd>{detected.project.hasSemanticModel ? 'Present' : 'None'}</dd>
              </div>
              <div>
                <dt>Format check</dt>
                <dd className="zt-detected__pass">PBIR — pass</dd>
              </div>
            </dl>
          </div>
        </div>
      ) : null}

      {step === 'ready' ? (
        <div className="zt-step" data-testid="attach-step-ready">
          <div className="zt-summary">
            <div className="zt-summary__row">
              <span className="zt-summary__label">Source</span>
              <code className="zt-summary__value">{detected ? destFolder : folderPath}</code>
            </div>
            <div className="zt-summary__row">
              <span className="zt-summary__label">Agent</span>
              <span className="zt-summary__value">{agent === 'claude' ? 'Claude Code' : 'Copilot'}</span>
            </div>
            {detected ? (
              <div className="zt-summary__row">
                <span className="zt-summary__label">Report</span>
                <span className="zt-summary__value">
                  {detected.project.name} · {detected.project.pageCount} page(s)
                </span>
              </div>
            ) : null}
          </div>

          <ProvisioningPanel agent={agent} projectPath={detected ? destFolder : folderPath} />

          {actionError ? (
            <div className="zt-notice zt-notice--error" role="alert" data-testid="attach-ready-error">
              <Icon name="alert-triangle" size={16} />
              <div>
                <p className="zt-notice__text">{actionError}</p>
                <button type="button" className="zt-btn" onClick={() => setStep('source')}>
                  Back to source
                </button>
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className="zt-btn zt-btn--primary"
            onClick={() => void openWorkspace()}
            disabled={busy}
            data-testid="attach-open-workspace"
          >
            {busy ? <Icon name="spinner" size={14} /> : null}
            <span>Open workspace</span>
          </button>
        </div>
      ) : null}
    </ZeroTwoWizardModal>
  );
}
