# Zero Two — Design Specification

**Version:** 1.0 (v1 scope)
**Audience:** Claude Design (this document is the design brief; produce screen designs from it)
**Companion document:** ZERO-TWO-IMPLEMENTATION-SPEC.md (technical contract — design must not invent features outside it)
**Platform:** Windows desktop app (Electron). Primary window 1440×900 minimum, resizable, optimized up to ultrawide.
**UI language:** English.

---

## 1. Product identity

Zero Two is a professional tool for BI consultants: an AI-agent workbench that builds and edits Power BI reports and semantic models. The user talks to an agent, watches a live-rendered preview of the actual report, and steers the work by dropping annotated pins directly on screenshots.

**Personality:** calm, precise, engineered. A power tool, not a toy. Closer to a well-designed IDE or a flight console than a consumer chat app. Confidence through restraint: generous whitespace, strong typographic hierarchy, few colors used deliberately.

**Visual direction:**
- Dark mode first (consultants live in dark IDEs); light mode is a v1 requirement but design dark as the hero.
- One signature accent color, used sparingly for primary actions, active states, and the pin system: a warm coral/pink-red (a quiet nod to the product name; think refined, desaturated coral — not neon). Everything else stays in a disciplined neutral scale.
- Secondary semantic colors only for status: green (pass), amber (warning), red (fail/error). These appear in pipeline steppers, rule results, and findings — never decoratively.
- Typography: a modern grotesque for UI (e.g. Inter-class), a monospace for code/DAX/JSON/log content. Tight, information-dense but breathable — density closer to Linear/VS Code than to a marketing site.
- Motion: minimal and functional. Streaming text, stepper progress, pin drop micro-feedback. No decorative animation.
- Iconography: single consistent outline icon set.

**Anti-goals:** no dashboard-y gradients, no glassmorphism, no mascot illustration, no marketing-page hero sections inside the app.

---

## 2. Information architecture

```
App shell
├── Projects home                 (start screen)
│   ├── New report wizard
│   └── Attach report wizard      (PBIX → PBIP guided conversion)
├── Workspace                     (the main screen; one per project)
│   ├── Chat & session panel      (left)
│   ├── Preview canvas            (center; comment mode lives here)
│   └── Context panel             (right; tabs: Pipeline, Rules, Findings, History)
├── Rules Studio                  (app-level; also reachable from Workspace)
├── Doctor                        (environment health)
└── Settings                      (agents & sign-in, Desktop bridge, preferences)
```

Global navigation: a slim left rail (icons + tooltips): Projects, Rules Studio, Doctor, Settings. The Workspace takes over the full window when a project is open, with a breadcrumb/project switcher in the title bar area.

---

## 3. Screens

### 3.1 Projects home
- Empty state (first run): centered card with two primary paths — "Attach a report" and "New report" — plus a tertiary "Run environment check" link if Doctor has warnings. Short one-line explanations under each.
- Populated state: project cards in a grid or dense list (design both, recommend one): project name, path (truncated, tooltip full), agent badge (Claude / Copilot), last activity, a small thumbnail of the last screenshot of page 1 if available. Card menu: Open, Re-provision, Remove (keeps files), Reveal in Explorer.
- A persistent, dismissible banner appears here if Doctor reports a hard failure (e.g. Power BI Desktop outdated).

### 3.2 Attach report wizard (the flagship onboarding flow — design with care)
A modal or full-screen stepper. Steps:
1. **Source** — drop zone accepting a `.pbix` file or "select an existing PBIP folder" (skips to step 4). Destination folder picker with a sensible default.
2. **Convert in Power BI Desktop** — the app has auto-launched Desktop with the file. This step is an illustrated checklist: "1. In Desktop: File → Save as → choose Power BI project (.pbip) → select the folder below." Show the destination path prominently with a copy button. A live status region at the bottom: "Watching folder… waiting for the project to appear" with a subtle activity indicator.
3. **Detected** — the watcher fired: show what was found (report name, page count, model present yes/no, format check pass). Auto-advances after a beat, or shows the *error variant*: legacy report format detected → instructions to enable the enhanced (PBIR) format and re-save, with a "watching again" state.
4. **Ready** — agent selection (Claude Code / Copilot; show sign-in state inline, with a sign-in action if needed), then a provisioning progress view (see 3.6), then "Open workspace".

Design principle for this wizard: the user performs one manual action (Save As) — everything before and after must feel automated. The waiting states are the emotional core; make them feel attentive, not stuck.

### 3.3 New report wizard
1. **Basics** — name, folder, agent (with sign-in state).
2. **Brief** — a large free-text brief field ("Describe the report: audience, KPIs, data, style…") with 2–3 ghost examples. Optional attachments row (reference image, logo) if trivially supportable; otherwise omit.
3. **Provisioning** progress (3.6) → opens Workspace, where the planning conversation continues in chat and ends in a Design Brief approval card (3.4.e).

### 3.4 Workspace (main screen)
Three-zone layout with draggable dividers. Default proportions ~ 28% / 48% / 24%.

**a) Chat & session panel (left)**
- Standard streaming chat: user/agent messages, tool-action rows rendered as compact, collapsible line items (icon + "Edited visuals/abc123/visual.json" style), distinct styling for system events.
- Composer at bottom: multiline input, send, stop-generation, and a small session control row (new session, model/agent indicator).
- Approval prompts (MCP elicitation confirmations, e.g. "The agent wants to modify the semantic model — allow?") render as inline decision cards with Allow / Deny buttons — visually distinct (accent border) so they never get lost in the stream.
- Session boundary markers ("Session #4 — baseline committed a1b2c3d").

**b) Preview canvas (center)**
- Top bar: page tabs (report page names, overflow into a dropdown), staleness chip ("Preview up to date" / "Files changed since last render — Refresh"), zoom controls (fit / 100% / +/-), Refresh preview button, and the **Comment mode toggle** (prominent, accent when active).
- Canvas: the page screenshot on a subtle checker/neutral surface, drop shadow, pannable/zoomable.
- Empty/starter states: no screenshots yet ("Run your first render" CTA), Desktop bridge down (full-canvas remediation state with a link to Doctor), rendering-in-progress (dimmed last screenshot + progress shimmer, never a blank flash).

**c) Comment mode (overlay on preview canvas)**
- Toggling on: canvas gets an accent-tinted border/frame; cursor becomes crosshair; a hint toast "Click to pin, drag to mark an area".
- **Pin** = numbered accent dot with a small stem; **rectangle** = accent-stroked area with the number badge at a corner.
- Placing either opens a lightweight popover: text field ("What should change here?"), the auto-matched visual shown as a chip ("→ Card: Revenue Won") with a dropdown caret to correct the match (list of page visuals), Save / Delete.
- A collapsible **Annotations tray** (bottom of the canvas or docked right edge of the center pane): the numbered list of draft pins with text previews, per-pin edit/delete, and the primary action **"Send N annotations to agent"**.
- Lifecycle states to design: draft (accent, full), submitted (dimmed, spinner while pipeline runs), resolved (dimmed check, auto-clears on next run or via "Clear resolved").

**d) Context panel (right) — four tabs**
1. **Pipeline** — a vertical stepper for the current run: Validate → Inspect → Reload → Screenshot → Commit. Each step: status icon (pending/running/pass/fail), duration, expandable detail (validator output, etc.). Failed Validate shows "auto-fix attempt 1 of 3" microcopy. This stepper is the heartbeat of the product — design it beautifully.
2. **Rules** — latest Fab Inspector run: summary chips (X passed / Y failed), grouped failures by rule with severity color, failing pages/visuals as clickable chips (clicking highlights the visual region on the preview if coordinates are known — nice-to-have). Actions: "Re-run", per-rule and global "Ask agent to fix". Empty state links to Rules Studio.
3. **Findings** (semantic model audit) — appears after a model audit: findings list grouped by severity, each with object name, description, checkbox if auto-fixable; footer bar "Apply N selected fixes". Include the entry point button "Run model audit" in this tab's empty state.
4. **History** — git timeline: commit rows (message, time, session badge), per-row Restore (destructive-styled, confirm dialog with consequence text) and View diff (opens a diff viewer — modal or drawer; design a simple unified-diff presentation with mono type).

**e) Design Brief approval card** (appears in chat during new-report flow)
A rich card rendering the agent-produced brief (markdown: sections, KPI lists), with sticky footer actions: **Approve & build** (primary/accent) and **Request changes** (focuses composer). This is a formal gate — make it feel like signing off a document.

### 3.5 Rules Studio
- Left: ruleset/rule list with enable toggles, severity dots, search. Empty state: "No rules yet. Rules are yours — Zero Two ships none." with "Create rule" and "Browse templates".
- Template gallery: cards (name, one-line description, parameters preview) — choosing one opens the builder pre-filled; explicit creation only.
- Rule editor, two modes via segmented control:
  - **Builder**: form fields (name, description, severity, template-specific parameters like "Max visuals per page: [8]").
  - **JSON**: monospace editor with lint markers.
- Per-rule footer: "Test against project…" (project picker if multiple) → inline results drawer (pass/fail, failing visuals list).

### 3.6 Provisioning progress (shared component)
A checklist-progress card used in both wizards and in "Re-provision": rows like "Adding Microsoft skills marketplace… ✓", "Installing powerbi-authoring… ✓", "Installing community plugins (pinned 26.25)… ⟳", "Verifying installed skills… ". Failure rows expand with the CLI output and a Retry button. End state: a compact provisioning report table (plugin / version / status).

### 3.7 Doctor
A single-column checklist page: each requirement (Power BI Desktop version, bridge preview feature, CLIs, Node, Git, agents signed in) as a row with status icon, detected value, and remediation text (with copyable commands) when failing. Header: overall status pill + "Re-check" button. Live bridge check row shows the connected Desktop instance (PID, open file) when a project is open.

### 3.8 Settings
Sections: **Agents** (per agent: installed/version/signed-in-as, Sign in / Sign out buttons — sign-in opens a terminal flow, so design the "waiting for sign-in to complete…" interstitial), **Rendering** (screenshot resolution, report-only vs with-model reload default), **Paths** (tool locations, read-mostly), **Project defaults** (default agent), **About** (version, licenses/attribution incl. open-design).

### 3.9 Shared/system states to design explicitly
- Desktop instance picker dialog (multiple Power BI Desktop instances detected: list with PID + open file; pick one).
- "Unsaved changes in Desktop?" passive reminder banner shown at session start (informational, dismissible: "PBIR files on disk are the source of truth — save in Desktop before letting the agent iterate").
- Destructive confirms (Restore commit, Delete rule).
- Global toast system (pipeline complete, screenshot updated, provisioning done).

---

## 4. Key components inventory (design as a mini system)

1. Pipeline stepper (vertical, 5 stages, all states).
2. Pin & rectangle annotation set (draft/submitted/resolved) + annotation popover + annotations tray.
3. Page tab strip with overflow.
4. Staleness chip (fresh / stale / rendering).
5. Approval decision card (MCP elicitation) and Design Brief approval card.
6. Findings row (severity, object, checkbox) + severity badges.
7. Rule row + rule result group.
8. Provisioning checklist card.
9. Agent tool-action row (collapsible) in chat.
10. Git commit row + diff viewer.
11. Doctor requirement row.
12. Empty states: projects, preview, rules, findings, history.

---

## 5. Interaction principles

1. **The preview is the truth.** Chat describes; the screenshot proves. Any claim of completion is visually anchored — the UI should always make "what changed" inspectable (fresh screenshot + pipeline green + commit row).
2. **Gates, not interruptions.** Approval moments (design brief, model modification consent, restore) are explicit cards/dialogs; everything else streams without blocking.
3. **One manual step, framed by automation** (attach wizard) — waiting states must communicate active watching.
4. **User-owned policy.** Rules Studio language always says "your rules"; the app never implies built-in opinions about report quality.
5. **Safety is visible.** Baseline commits and history restore are surfaced, not buried — the user should feel free to let the agent run because undo is one click away.
6. Keyboard: Cmd/Ctrl+Enter send, C toggles comment mode, Esc exits comment mode/closes popovers, 1–9 jump to page tabs (document in a shortcuts sheet).

---

## 6. Deliverables requested from Claude Design

Produce high-fidelity screens (dark mode primary; one light-mode variant of the Workspace to establish the mapping):
1. Projects home (empty + populated).
2. Attach wizard — all four steps, including the waiting/watching state and the legacy-format error variant.
3. Workspace — default state (chat streaming + fresh preview + pipeline running).
4. Workspace — comment mode active with 3 annotations (two pins, one rectangle), popover open on one, tray visible.
5. Workspace — Rules tab with failures + "Ask agent to fix".
6. Workspace — Findings tab after a model audit.
7. Design Brief approval card (in chat context).
8. Rules Studio — list + builder mode + JSON mode.
9. Doctor (one failure present).
10. Settings — Agents section with one signed-in and one signed-out agent.
11. Component sheet: the inventory in §4 with all states.
12. Design tokens: color scale (neutrals, accent, semantic), type scale, spacing, radii — delivered as a token table the implementation can mirror.
