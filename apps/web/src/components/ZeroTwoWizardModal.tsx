// Shared modal chrome for the Zero Two Phase 2 wizards (attach + new report).
//
// A focus-trapped, Esc-dismissable dialog with a header (title + subtitle +
// close) and a body slot. Kept intentionally small — the wizard-specific
// stepper and content live in the individual wizard components.

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Optional right-aligned slot in the header (e.g. a step indicator). */
  headerAside?: ReactNode;
  children: ReactNode;
  testId?: string;
}

export function ZeroTwoWizardModal({ open, title, subtitle, onClose, headerAside, children, testId }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useRef(`zt-wizard-title-${Math.random().toString(36).slice(2)}`).current;

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="zt-wizard-overlay" onMouseDown={onClose} data-testid={testId}>
      <div
        ref={dialogRef}
        className="zt-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="zt-wizard__head">
          <div className="zt-wizard__head-copy">
            <h1 id={titleId} className="zt-wizard__title">
              {title}
            </h1>
            {subtitle ? <p className="zt-wizard__subtitle">{subtitle}</p> : null}
          </div>
          {headerAside ? <div className="zt-wizard__head-aside">{headerAside}</div> : null}
          <button
            type="button"
            className="zt-wizard__close"
            onClick={onClose}
            aria-label="Close wizard"
            data-testid="zt-wizard-close"
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="zt-wizard__body">{children}</div>
      </div>
    </div>
  );
}
