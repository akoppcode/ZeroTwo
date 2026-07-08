// Screenshot preview pane (design spec §7) — the center pane showing the latest
// captured pipeline run. Page tabs come from the report inventory (displayName,
// order, hidden chip); each page renders its captured PNG in a zoom / pan
// canvas. A staleness pill warns when a newer run has started but not yet
// re-captured, and a "Refresh preview" button re-runs the pipeline.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnnotationCanvas } from './AnnotationCanvas';
import { Icon } from './Icon';
import type { ReportPage } from './pipeline-types';

interface Props {
  projectId: string;
  /** Report page inventory (order + display metadata). */
  pages: ReportPage[];
  /** Run whose screenshots are shown, or null before the first capture. */
  runId: string | null;
  /** Page names (page.name) captured in the shown run. */
  capturedPages: string[];
  /** A newer run started without re-capturing the shown preview. */
  stale: boolean;
  /** A pipeline run is in flight (disables the refresh button). */
  refreshing: boolean;
  /** Re-run the pipeline (full run; the daemon exposes no reload-only path). */
  onRefresh: () => void;
  /** Stable session id for comment-mode annotations (spec §9). */
  sessionId: string;
  /** Optional sink for a submitted annotation prompt (future Workspace → chat). */
  onSubmitPrompt?: (prompt: string) => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

export function PreviewPane({
  projectId,
  pages,
  runId,
  capturedPages,
  stale,
  refreshing,
  onRefresh,
  sessionId,
  onSubmitPrompt,
}: Props) {
  const [activePage, setActivePage] = useState<string | null>(pages[0]?.name ?? null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [commentMode, setCommentMode] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  // Keep the active tab valid as the inventory changes.
  useEffect(() => {
    if (pages.length === 0) {
      setActivePage(null);
      return;
    }
    setActivePage((prev) => (prev && pages.some((p) => p.name === prev) ? prev : pages[0]!.name));
  }, [pages]);

  const captured = useMemo(() => new Set(capturedPages), [capturedPages]);
  const hasShot = activePage != null && runId != null && captured.has(activePage);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Reset zoom / pan when the shown page or run changes.
  useEffect(() => {
    resetView();
  }, [activePage, runId, resetView]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (zoom <= 1) return;
      dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [zoom, pan],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPan({ x: drag.panX + (e.clientX - drag.startX), y: drag.panY + (e.clientY - drag.startY) });
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be released
    }
  }, []);

  const imgSrc =
    hasShot && activePage
      ? `/api/projects/${projectId}/screenshots/${runId}/${encodeURIComponent(activePage)}.png`
      : null;
  const activePageObj = activePage != null ? pages.find((p) => p.name === activePage) ?? null : null;

  return (
    <section className="zt-preview" aria-label="Report preview" data-testid="preview-pane">
      <header className="zt-preview__bar">
        <div className="zt-preview__tabs" role="tablist" aria-label="Report pages">
          {pages.map((page) => {
            const selected = page.name === activePage;
            return (
              <button
                key={page.name}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`zt-preview__tab${selected ? ' zt-preview__tab--active' : ''}`}
                onClick={() => setActivePage(page.name)}
                data-testid={`preview-tab-${page.name}`}
              >
                <span className="zt-preview__tab-name">{page.displayName}</span>
                {page.hidden ? <span className="zt-preview__hidden-chip">hidden</span> : null}
              </button>
            );
          })}
        </div>

        <div className="zt-preview__tools">
          {stale ? (
            <span className="zt-preview__stale" role="status" data-testid="preview-stale">
              <Icon name="alert-triangle" size={12} />
              Preview may be stale — refresh
            </span>
          ) : null}
          <button
            type="button"
            className={`zt-btn${commentMode ? ' zt-btn--primary' : ''}`}
            onClick={() => setCommentMode((v) => !v)}
            disabled={!hasShot}
            aria-pressed={commentMode}
            aria-label="Toggle comment mode"
            data-testid="preview-comment-toggle"
          >
            <Icon name="comment" size={13} />
            <span>{commentMode ? 'Commenting' : 'Comment'}</span>
          </button>
          <div className="zt-preview__zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              className="zt-icon-btn"
              onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
              disabled={!hasShot || zoom <= MIN_ZOOM}
              aria-label="Zoom out"
              data-testid="preview-zoom-out"
            >
              <Icon name="zoom-out" size={14} />
            </button>
            <button
              type="button"
              className="zt-icon-btn"
              onClick={resetView}
              disabled={!hasShot}
              aria-label="Fit to view"
              data-testid="preview-fit"
            >
              <span className="zt-preview__zoom-level">{Math.round(zoom * 100)}%</span>
            </button>
            <button
              type="button"
              className="zt-icon-btn"
              onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
              disabled={!hasShot || zoom >= MAX_ZOOM}
              aria-label="Zoom in"
              data-testid="preview-zoom-in"
            >
              <Icon name="zoom-in" size={14} />
            </button>
          </div>
          <button
            type="button"
            className="zt-btn"
            onClick={onRefresh}
            disabled={refreshing}
            data-testid="preview-refresh"
          >
            <Icon name={refreshing ? 'spinner' : 'refresh'} size={13} />
            <span>{refreshing ? 'Refreshing…' : 'Refresh preview'}</span>
          </button>
        </div>
      </header>

      {commentMode && imgSrc && activePageObj ? (
        <AnnotationCanvas
          projectId={projectId}
          sessionId={sessionId}
          page={activePageObj}
          runId={runId}
          screenshotUrl={imgSrc}
          zoom={zoom}
          pan={pan}
          {...(onSubmitPrompt ? { onSubmitPrompt } : {})}
        />
      ) : (
        <div
          className={`zt-preview__canvas${zoom > 1 ? ' zt-preview__canvas--pannable' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          data-testid="preview-canvas"
        >
          {imgSrc && activePage ? (
            <img
              src={imgSrc}
              alt={`Screenshot of ${activePageObj?.displayName ?? activePage}`}
              className="zt-preview__img"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              draggable={false}
              data-testid="preview-img"
            />
          ) : (
            <div className="zt-preview__empty" data-testid="preview-empty">
              <Icon name="image" size={22} />
              <p>
                {runId == null
                  ? 'Run the pipeline to capture a preview of every page.'
                  : 'This page was not captured in the latest run.'}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
