// Comment-mode annotation canvas (design spec §9.1) — layered over the
// screenshot preview. Click drops a point pin, drag draws a rectangle; each new
// annotation opens a text field in the side list. Markers are positioned as a
// fraction of the report page's canvas units, so they track the image at any
// zoom / pan (the overlay covers the transformed <img> box exactly). The daemon
// hit-tests each annotation against the page's PBIR visuals on create (spec
// §9.3) and we render what it returns; the user can correct the matched visual
// via a dropdown (PATCH). "Send to agent" submits the session's drafts and
// surfaces the synthesized §9.4 prompt block(s).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { ReportPage } from './pipeline-types';

/** Annotation as returned by the daemon (apps/daemon .../annotation-service.ts). */
export interface Annotation {
  id: string;
  sessionId: string;
  pageName: string;
  kind: 'pin' | 'rect';
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  canvasX: number | null;
  canvasY: number | null;
  canvasW: number | null;
  canvasH: number | null;
  text: string;
  visualId: string | null;
  visualType: string | null;
  visualTitle: string | null;
  matchKind: string | null;
  status: 'draft' | 'submitted' | 'resolved';
}

interface Props {
  projectId: string;
  /** Stable per-view session id (ties the annotations together). */
  sessionId: string;
  /** The active report page — supplies canvas units + the visual list. */
  page: ReportPage;
  runId: string | null;
  screenshotUrl: string;
  /** Applied to the image stage so the existing zoom / pan controls drive it. */
  zoom?: number;
  pan?: { x: number; y: number };
  /**
   * Optional sink for the submitted prompt (a future Workspace pipes it into the
   * active chat). When absent the prompt is only shown in the copyable panel.
   * TODO(chat phase): submit should post the block(s) into the live agent session.
   */
  onSubmitPrompt?: (prompt: string) => void;
}

/** Movement (px) under which a pointer gesture counts as a click, not a drag. */
const DRAG_THRESHOLD = 4;

const MATCH_LABELS: Record<string, string> = {
  contains: 'contained',
  intersects: 'overlaps',
  nearest: 'nearest',
  manual: 'manual',
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Fraction (0–1) of a canvas coordinate within the page, for marker placement. */
function fraction(canvas: number | null, px: number, span: number | null, naturalSpan: number): number {
  if (span && span > 0 && canvas != null) return clamp01(canvas / span);
  if (naturalSpan > 0) return clamp01(px / naturalSpan);
  return 0;
}

function matchTone(a: Annotation): 'match-high' | 'match-mid' | 'match-low' | 'match-manual' | 'match-none' {
  if (a.matchKind === 'manual') return 'match-manual';
  if (a.matchKind === 'contains') return 'match-high';
  if (a.matchKind === 'intersects') return 'match-mid';
  if (a.matchKind === 'nearest') return 'match-low';
  return 'match-none';
}

function visualLabel(a: Annotation): string {
  return a.visualTitle || a.visualType || a.visualId || 'no visual matched';
}

export function AnnotationCanvas({
  projectId,
  sessionId,
  page,
  runId,
  screenshotUrl,
  zoom = 1,
  pan = { x: 0, y: 0 },
  onSubmitPrompt,
}: Props) {
  const [all, setAll] = useState<Annotation[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const gestureRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  // Load the session's annotations on mount / when the session changes. The
  // daemon persists them, so a reload re-fetches — that is the persistence.
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/annotations?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : { annotations: [] }))
      .then((data: { annotations?: Annotation[] }) => {
        if (!cancelled) setAll(Array.isArray(data.annotations) ? data.annotations : []);
      })
      .catch(() => {
        /* keep whatever we have; annotations reload on next mount */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, runId]);

  const visible = useMemo(() => all.filter((a) => a.pageName === page.name), [all, page.name]);

  const natural = () => ({
    w: imgRef.current?.naturalWidth ?? 0,
    h: imgRef.current?.naturalHeight ?? 0,
  });

  const upsert = useCallback((a: Annotation) => {
    setAll((prev) => {
      const idx = prev.findIndex((p) => p.id === a.id);
      if (idx === -1) return [...prev, a];
      const next = prev.slice();
      next[idx] = a;
      return next;
    });
  }, []);

  const createAnnotation = useCallback(
    async (fx0: number, fy0: number, fx1: number | null, fy1: number | null) => {
      const { w: nw, h: nh } = natural();
      const pageW = page.width ?? nw;
      const pageH = page.height ?? nh;
      const isRect = fx1 != null && fy1 != null;
      const left = isRect ? Math.min(fx0, fx1!) : fx0;
      const top = isRect ? Math.min(fy0, fy1!) : fy0;
      const fw = isRect ? Math.abs(fx1! - fx0) : 0;
      const fh = isRect ? Math.abs(fy1! - fy0) : 0;

      const body = {
        sessionId,
        pageName: page.name,
        kind: isRect ? ('rect' as const) : ('pin' as const),
        x: Math.round(left * nw),
        y: Math.round(top * nh),
        ...(isRect ? { w: Math.round(fw * nw), h: Math.round(fh * nh) } : {}),
        canvasX: left * pageW,
        canvasY: top * pageH,
        ...(isRect ? { canvasW: fw * pageW, canvasH: fh * pageH } : {}),
        text: '',
      };
      try {
        const res = await fetch(`/api/projects/${projectId}/annotations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { annotation: Annotation };
        upsert(data.annotation);
        setEditingId(data.annotation.id);
        setSelectedId(data.annotation.id);
      } catch {
        /* creation failed; the canvas stays as-is */
      }
    },
    [projectId, sessionId, page.name, page.width, page.height, upsert],
  );

  const patch = useCallback(
    async (id: string, patchBody: Partial<Pick<Annotation, 'text' | 'visualId' | 'visualType' | 'visualTitle'>>) => {
      try {
        const res = await fetch(`/api/annotations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { annotation: Annotation };
        upsert(data.annotation);
      } catch {
        /* leave local state; will re-sync on reload */
      }
    },
    [upsert],
  );

  const remove = useCallback(async (id: string) => {
    setAll((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch(`/api/annotations/${id}`, { method: 'DELETE' });
    } catch {
      /* already removed locally */
    }
  }, []);

  // --- Pointer gestures on the overlay (click = pin, drag = rectangle) --------

  const frac = useCallback((clientX: number, clientY: number) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const f = frac(e.clientX, e.clientY);
      if (!f) return;
      gestureRef.current = { startX: e.clientX, startY: e.clientY, moved: false };
      setDraft({ x0: f.x, y0: f.y, x1: f.x, y1: f.y });
      overlayRef.current?.setPointerCapture(e.pointerId);
    },
    [frac],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      if (Math.abs(e.clientX - g.startX) > DRAG_THRESHOLD || Math.abs(e.clientY - g.startY) > DRAG_THRESHOLD) {
        g.moved = true;
      }
      const f = frac(e.clientX, e.clientY);
      if (f) setDraft((prev) => (prev ? { ...prev, x1: f.x, y1: f.y } : prev));
    },
    [frac],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      try {
        overlayRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already released */
      }
      const d = draft;
      setDraft(null);
      if (!g || !d) return;
      if (g.moved) void createAnnotation(d.x0, d.y0, d.x1, d.y1);
      else void createAnnotation(d.x0, d.y0, null, null);
    },
    [draft, createAnnotation],
  );

  // Esc cancels an in-progress draft rectangle.
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        gestureRef.current = null;
        setDraft(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/annotations/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { blocks?: { pageName: string; prompt: string }[] };
      const text = (data.blocks ?? []).map((b) => b.prompt).join('\n\n');
      setPrompt(text);
      if (text && onSubmitPrompt) onSubmitPrompt(text);
      // Drafts flipped to submitted server-side — re-fetch to dim them.
      const listed = await fetch(`/api/annotations?sessionId=${encodeURIComponent(sessionId)}`)
        .then((r) => (r.ok ? r.json() : { annotations: [] }))
        .catch(() => ({ annotations: [] }));
      setAll(Array.isArray(listed.annotations) ? listed.annotations : []);
    } finally {
      setSubmitting(false);
    }
  }, [projectId, sessionId, onSubmitPrompt]);

  const copyPrompt = useCallback(async () => {
    if (!prompt || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }, [prompt]);

  const { w: nw, h: nh } = { w: imgRef.current?.naturalWidth ?? 0, h: imgRef.current?.naturalHeight ?? 0 };
  const hasDrafts = visible.some((a) => a.status === 'draft');

  return (
    <div className="zt-annot" data-testid="annotation-canvas">
      <div className="zt-annot__stage-wrap">
        <div
          className="zt-annot__stage"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <img
            ref={imgRef}
            src={screenshotUrl}
            alt={`Comment on ${page.displayName}`}
            className="zt-annot__img"
            draggable={false}
            data-testid="annotation-img"
          />
          <div
            ref={overlayRef}
            className="zt-annot__overlay"
            role="application"
            aria-label="Annotation canvas — click to pin, drag to box"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            data-testid="annotation-overlay"
          >
            <div className="zt-annot__markers">
              {visible.map((a) => {
                const left = fraction(a.canvasX, a.x, page.width, nw) * 100;
                const top = fraction(a.canvasY, a.y, page.height, nh) * 100;
                const selected = a.id === selectedId;
                const common = `zt-annot__marker zt-annot__marker--${matchTone(a)} zt-annot__marker--${a.status}${
                  selected ? ' is-selected' : ''
                }`;
                if (a.kind === 'rect') {
                  const wPct = fraction(a.canvasW, a.w ?? 0, page.width, nw) * 100;
                  const hPct = fraction(a.canvasH, a.h ?? 0, page.height, nh) * 100;
                  return (
                    <div
                      key={a.id}
                      className={`${common} zt-annot__marker--rect`}
                      style={{ left: `${left}%`, top: `${top}%`, width: `${wPct}%`, height: `${hPct}%` }}
                      data-testid={`annotation-marker-${a.id}`}
                      data-status={a.status}
                    >
                      <button
                        type="button"
                        className="zt-annot__marker-tag"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setSelectedId(a.id)}
                        aria-label={`Annotation on ${visualLabel(a)}`}
                      >
                        {visualLabel(a)}
                      </button>
                    </div>
                  );
                }
                return (
                  <div
                    key={a.id}
                    className={common}
                    style={{ left: `${left}%`, top: `${top}%` }}
                    data-testid={`annotation-marker-${a.id}`}
                    data-status={a.status}
                  >
                    <button
                      type="button"
                      className="zt-annot__pin"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setSelectedId(a.id)}
                      aria-label={`Annotation on ${visualLabel(a)}`}
                    />
                  </div>
                );
              })}
              {draft ? (
                <div
                  className="zt-annot__marker zt-annot__marker--draft-preview"
                  style={{
                    left: `${Math.min(draft.x0, draft.x1) * 100}%`,
                    top: `${Math.min(draft.y0, draft.y1) * 100}%`,
                    width: `${Math.abs(draft.x1 - draft.x0) * 100}%`,
                    height: `${Math.abs(draft.y1 - draft.y0) * 100}%`,
                  }}
                  data-testid="annotation-draft-preview"
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <aside className="zt-annot__side" aria-label="Annotations">
        <header className="zt-annot__side-head">
          <span className="zt-annot__side-title">Comments</span>
          <span className="zt-annot__count">{visible.length}</span>
        </header>

        <ul className="zt-annot__list" data-testid="annotation-list">
          {visible.length === 0 ? (
            <li className="zt-annot__empty">Click the screenshot to drop a pin, or drag to box a visual.</li>
          ) : (
            visible.map((a) => (
              <li
                key={a.id}
                className={`zt-annot__item zt-annot__item--${a.status}${a.id === selectedId ? ' is-selected' : ''}`}
                data-testid={`annotation-item-${a.id}`}
                onClick={() => setSelectedId(a.id)}
              >
                <div className="zt-annot__item-top">
                  <span className={`zt-annot__chip zt-annot__chip--${matchTone(a)}`} title={`match: ${a.matchKind ?? 'none'}`}>
                    <Icon name={a.kind === 'rect' ? 'layout' : 'comment'} size={11} />
                    {visualLabel(a)}
                    {a.matchKind ? <em className="zt-annot__match">{MATCH_LABELS[a.matchKind] ?? a.matchKind}</em> : null}
                  </span>
                  <button
                    type="button"
                    className="zt-icon-btn zt-annot__del"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(a.id);
                    }}
                    aria-label="Delete annotation"
                    data-testid={`annotation-delete-${a.id}`}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>

                {editingId === a.id ? (
                  <input
                    className="zt-annot__text-input"
                    autoFocus
                    defaultValue={a.text}
                    placeholder="Describe the change…"
                    aria-label="Annotation text"
                    data-testid={`annotation-text-input-${a.id}`}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      setEditingId(null);
                      if (e.target.value !== a.text) void patch(a.id, { text: e.target.value });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="zt-annot__text"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(a.id);
                    }}
                    data-testid={`annotation-text-${a.id}`}
                  >
                    {a.text || <span className="zt-annot__text-placeholder">Add a comment…</span>}
                  </button>
                )}

                <label className="zt-annot__visual-select">
                  <span className="zt-annot__visual-label">Visual</span>
                  <select
                    className="zt-annot__select"
                    value={a.visualId ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = page.visuals.find((pv) => pv.id === e.target.value);
                      if (!v) return;
                      void patch(a.id, { visualId: v.id, visualType: v.visualType ?? '', visualTitle: v.title ?? '' });
                    }}
                    data-testid={`annotation-visual-select-${a.id}`}
                  >
                    <option value="" disabled>
                      {a.visualId ? visualLabel(a) : 'Pick a visual…'}
                    </option>
                    {page.visuals.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.title || v.visualType || v.id}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))
          )}
        </ul>

        <div className="zt-annot__submit-row">
          <button
            type="button"
            className="zt-btn zt-btn--primary"
            onClick={() => void submit()}
            disabled={submitting || !hasDrafts}
            data-testid="annotation-submit"
          >
            <Icon name={submitting ? 'spinner' : 'send'} size={14} />
            <span>{submitting ? 'Sending…' : 'Send to agent'}</span>
          </button>
        </div>

        {prompt != null ? (
          <section
            className="zt-annot__prompt"
            tabIndex={0}
            aria-label="Synthesized agent prompt"
            data-testid="annotation-prompt"
          >
            <header className="zt-annot__prompt-head">
              <span>Prompt for the agent</span>
              <button
                type="button"
                className="zt-btn zt-btn--ghost"
                onClick={() => void copyPrompt()}
                data-testid="annotation-prompt-copy"
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} />
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </header>
            {/* TODO(chat phase): send this straight into the active agent session. */}
            <pre className="zt-annot__prompt-body">{prompt}</pre>
          </section>
        ) : null}
      </aside>
    </div>
  );
}
