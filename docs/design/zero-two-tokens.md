# Zero Two — design tokens (extracted from `zero-two-design.html`)

The authoritative visual system, pulled from the design mockup. Apply these to
all Zero Two views (Doctor, wizards, projects, pipeline/preview, comment mode,
Rules Studio) via `apps/web/src/styles/zero-two-theme.css`.

## Typography
- Sans: **Geist**, system-ui, sans-serif
- Mono: **Geist Mono**, monospace  (code, paths, rule ids, stage detail)

## Color — backgrounds (dark, layered, darkest → raised)
| Token | Hex | Use |
|---|---|---|
| `--zt-bg-abyss` | `#0A0C10` | deepest (behind panels) |
| `--zt-bg-app` | `#12151B` | app background |
| `--zt-bg-surface` | `#171B23` | cards / panels |
| `--zt-bg-raised` | `#1F242E` | inputs, raised rows |
| `--zt-bg-raised-2` | `#262D38` | hover / active surface |

## Color — borders
| `--zt-border` | `#2A313E` | default 1px border |
| `--zt-border-soft` | `#232A35` | subtle divider |

## Color — text
| `--zt-text` | `#E9EDF3` | primary |
| `--zt-text-dim` | `#C6CDD8` | secondary |
| `--zt-text-muted` | `#8892A0` | muted / labels |
| `--zt-text-faint` | `#6B7484` | disabled / hints |

## Color — accent + semantic
| `--zt-accent` | `#E8776B` | coral accent (primary action, active pins) |
| `--zt-accent-strong` | `#D95F52` | hover / pressed / filled buttons |
| `--zt-info` | `#4180C4` | links / info |
| `--zt-success` | `#55B98B` | pass / signed-in / verified |
| amber/red | (semantic warning/error) | keep existing semantic amber/red for rule severity + failures |

## Radii
- chips/small: `2–5px` · controls/cards: `6–8px` · large panels: `10px`

## Spacing (control padding)
- chip: `2px 7px` · button: `5px 11px`

Coral is used sparingly for the single primary action / active state; everything
else is the layered dark neutrals. Semantic green/amber/red only for status.
