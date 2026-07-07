interface Props {
  id: string;
  size?: number;
  className?: string;
}

// Agents that ship a bundled brand asset under `apps/web/public/agent-icons/`.
// SVG is preferred (resolution-independent, single file ≤ a few KB). New
// brand: drop the optimised file in that folder and add the id here.
const ICON_EXT: Record<string, 'svg' | 'png'> = {
  claude: 'svg',
  copilot: 'svg',
};

export function AgentIcon({ id, size = 36, className }: Props) {
  const cls = 'agent-icon' + (className ? ' ' + className : '');
  const ext = ICON_EXT[id];
  if (ext) {
    return (
      <img
        src={`/agent-icons/${id}.${ext}`}
        alt=""
        width={size}
        height={size}
        className={cls}
        aria-hidden="true"
        draggable={false}
      />
    );
  }
  // Fallback for brands we don't ship artwork for. A neutral rounded
  // square with the initial letter — reads as "no official mark yet"
  // without inventing brand artwork we can't license.
  const initial = (id.match(/[a-z]/i)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={cls + ' agent-icon-fallback'}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
