// Project-level action bar mounted between the AppChromeHeader and
// the chat-and-workspace split (#451). Hosts the project-scoped
// "Continue in CLI" action; per-file actions (Export PDF/PPTX/ZIP,
// Deploy) stay in the FileViewer share menu where they already live.
//
// The bar is intentionally thin: presentation, layout, and a couple
// of conditional flags. Behavior lives in ProjectView (handlers,
// hooks) and the per-button components.

import { ContinueInCliButton } from './ContinueInCliButton';
import type { DesignMdState } from '../hooks/useDesignMdState';

export interface ProjectActionsToolbarProps {
  designMdState: Pick<DesignMdState, 'exists' | 'isStale' | 'staleReason'>;
  onContinueInCli: () => void | Promise<void>;
  hidden?: boolean;
}

export function ProjectActionsToolbar({
  designMdState,
  onContinueInCli,
  hidden,
}: ProjectActionsToolbarProps) {
  if (hidden) return null;
  return (
    <div
      className="project-actions-toolbar"
      role="toolbar"
      aria-label="Project actions"
    >
      <ContinueInCliButton designMdState={designMdState} onClick={onContinueInCli} />
    </div>
  );
}
