# Zero Two — Implementation Specification

**Version:** 1.0 (v1 scope)
**Audience:** Claude Code (this document is the build contract)
**Repository:** https://github.com/akoppcode/ZeroTwo
**Platform:** Windows 10/11 native only (no WSL, no macOS/Linux in v1)
**UI language:** English

---

## 0. Reference repositories and how to execute this spec

**Upstream sources (read before the relevant phase; never guess details these sources answer):**

| Repository / docs | URL | Role in Zero Two | Read for |
|---|---|---|---|
| open-design | https://github.com/nexu-io/open-design | Forked as the application shell (§2) | Daemon, adapter layer, Electron/renderer structure — map in Phase 0 |
| Skills for Fabric (Microsoft) | https://github.com/microsoft/skills-for-fabric | Primary skill marketplace installed per project (§5.3) | Exact marketplace/plugin install commands, skill names, CLI usage |
| Power BI agentic docs (Microsoft Learn) | https://learn.microsoft.com/en-us/power-bi/developer/agentic/power-bi-agentic-overview | Canonical documentation for the skills, bridge CLI, and authoring CLI | Prerequisites, workflow contracts, troubleshooting |
| power-bi-agentic-development (community, Kurt Buhler) | https://github.com/data-goblin/power-bi-agentic-development | Second marketplace: PBIR hooks, Deneb/Vega-Lite, DAX plugins — **pin release 26.25** (§5.3) | Current plugin names, hook behavior, install commands |
| Power BI Modeling MCP server | https://github.com/microsoft/powerbi-modeling-mcp | Semantic-model tool registered by the Microsoft plugin (§8) | Connection modes, elicitation options, tool surface |
| Fab Inspector (PBI Inspector V2) | https://github.com/NatVanG/fab-inspector | Rules engine behind Rules Studio (§10) | CLI invocation, rules JSON format, output format |

**Execution model for Claude Code:**
1. Work strictly phase by phase (§14), one phase per branch/PR. Do not start a phase before the previous phase's acceptance criteria pass in CI.
2. Every "verify at build time" marker in this spec is a task: resolve it by reading the relevant upstream source above, and record the resolution (command, format, field names) in `docs/ARCHITECTURE.md` so the spec's open questions converge to documented facts.
3. When an upstream detail contradicts this spec, upstream wins for mechanics (commands, formats); this spec wins for product decisions (scope, flows, constraints in §1).

---

## 1. Product summary

Zero Two is a local-first Windows desktop application that lets consultants build and edit Microsoft Power BI reports and semantic models through AI coding agents, without hand-editing JSON or TMDL. The user connects their own agent subscription (Claude Code or GitHub Copilot CLI), attaches an existing PBIP project (converted from PBIX by the user, with a guided wizard) or scaffolds a new one, and works through a chat + live-preview loop. The agent edits PBIR/TMDL files on disk; Power BI Desktop (via the Desktop Bridge) renders the result; Zero Two shows screenshots in the app; the user iterates via chat or by dropping annotated pins directly on the screenshots ("comment mode").

### v1 goals
1. Attach existing PBIP projects and scaffold new report projects.
2. Guided PBIX → PBIP conversion wizard (user performs Save As in Desktop; app automates everything around it).
3. Dual agent support via subscription login only: Claude Code and GitHub Copilot CLI.
4. Automated skill/plugin provisioning per project from two upstream marketplaces (Microsoft `skills-for-fabric`, community `power-bi-agentic-development`).
5. Full iteration loop: agent edit → structural validation → user-rule inspection (Fab Inspector) → Desktop reload → screenshots → in-app preview.
6. Comment mode: multiple pins/rectangles on screenshots, auto-mapped to visual IDs, batched into one structured prompt.
7. Semantic model workflows: create/modify model objects and DAX measures/KPIs via the Power BI Modeling MCP server; run best-practice audits and surface findings with apply-fix flow.
8. Rules Studio: per-user Fab Inspector rules authored inside the app. No shipped/shared rule set — rules are user-defined.
9. Git safety net: local repo auto-init, baseline commit before every agent session, auto-commit after every accepted iteration. Optional user-configured remote.

### Explicit non-goals (v1)
- No publishing to Fabric workspaces.
- No Fabric REST API usage at all (no import, no getDefinition, no staging workspaces). PBIX conversion is done by the user in Power BI Desktop via the guided wizard.
- No API-key authentication for agents. Subscription login only. Never prompt for, accept, or store an Anthropic or OpenAI/GitHub API key.
- No cloud rendering fallback. Desktop Bridge is the only renderer.
- No isolation/VM/sandbox modes.
- No telemetry, no external analytics.

---

## 2. Foundation: fork of open-design

Zero Two is a hard fork of https://github.com/nexu-io/open-design (Apache-2.0). Keep the license file and add attribution in `NOTICE`.

### 2.1 First task: repo survey
Before writing code, clone open-design and produce `docs/UPSTREAM-MAP.md` mapping its actual structure (do not trust assumed paths). Identify at minimum:
- The local daemon (HTTP server, SQLite persistence, SSE streaming to renderer).
- The agent adapter layer (where CLI processes are spawned with `cwd` set to the project folder, and where stdout stream formats per CLI are parsed). Claude Code and Copilot adapters exist upstream — these two are kept; all other CLI adapters are removed.
- The Electron shell + web renderer (Next.js or equivalent).
- The project/workspace registry and chat/session persistence.
- The preview mechanism (iframe-based) — this is removed and replaced (see §7).

### 2.2 Strip list
Remove: image/video generation, slide/deck features, landing-page/design-system catalogs, all agent adapters except `claude` and `copilot`, the iframe preview, any BYOK API-key configuration UI and storage. Rename app identifiers to Zero Two (`com.akoppcode.zerotwo`).

### 2.3 Keep list
Daemon skeleton (HTTP + SSE + SQLite), adapter contract and stream parsers for Claude Code and Copilot CLI, chat UI with streaming, project registry, settings persistence, Electron packaging setup.

### 2.4 Monorepo layout (target)
```
ZeroTwo/
  apps/
    daemon/        # Node/TypeScript local server (Express or upstream equivalent)
    desktop/       # Electron main process
    web/           # Renderer (Next.js/React)
  packages/
    shared/        # Types shared daemon<->renderer (events, models)
  fixtures/
    sample.pbip/   # Committed minimal PBIR-format PBIP fixture for tests
  scripts/
    setup.ps1      # Environment setup (see §3)
    doctor.ps1     # Standalone environment check
  docs/
    UPSTREAM-MAP.md
    ARCHITECTURE.md
```

---

## 3. Environment, prerequisites, and setup script

### 3.1 Required on the user machine
| Component | Requirement | Check method |
|---|---|---|
| Windows | 10/11 x64 | `os` module |
| Power BI Desktop | **≥ 2.155.756.0 (June 2026 release)** | registry / `PBIDesktop.exe` file version |
| Desktop preview feature | "Enable external tool access to Power BI Desktop through secure local APIs" enabled | `powerbi-desktop status` returns connected when a report is open; otherwise instruct user |
| Node.js | ≥ 20 LTS | `node --version` |
| Git | any recent | `git --version` |
| `@microsoft/powerbi-desktop-bridge-cli` | global npm, command `powerbi-desktop` | `powerbi-desktop --version` / `manifest` |
| `@microsoft/powerbi-report-authoring-cli` | global npm, command `powerbi-report-author` | `powerbi-report-author --version` |
| Fab Inspector CLI (NatVanG/fab-inspector, PBI Inspector V2) | installed per its README (dotnet-based CLI or release binary) | invoke `--help` |
| Claude Code and/or GitHub Copilot CLI | at least one, logged in via subscription | see §5.2 |

Note: the Microsoft CLIs are preview packages; `setup.ps1` must read the installed package README/version at install time rather than hardcoding flags, and `doctor` must re-run `powerbi-desktop manifest` after Desktop updates because the bridge method surface can change between Desktop versions.

### 3.2 setup.ps1 behavior
1. Verify/install Node LTS (winget), Git (winget).
2. `npm install -g @microsoft/powerbi-desktop-bridge-cli @microsoft/powerbi-report-authoring-cli`.
3. Install Fab Inspector CLI per upstream instructions; record install path in `%APPDATA%/ZeroTwo/config.json`.
4. Detect Power BI Desktop version; if < 2.155.756.0, print upgrade instructions and mark doctor state `desktop_outdated`.
5. Detect Claude Code (`claude`) and Copilot CLI; report login state for each (do not attempt login inside the script — the app guides login interactively, §5.2).
6. Print a doctor summary table. Exit non-zero if any hard requirement missing.

### 3.3 In-app Doctor
A daemon service `EnvironmentService` re-runs all checks on app start and on demand (`GET /api/doctor`). The renderer shows a Doctor screen with per-item status, remediation text, and re-check button. The most important live check: with a project open, `powerbi-desktop status` must list a running Desktop instance and the bridge named pipe (`pbi-desktop-bridge-<pid>`) must be connectable; if `not_connected`, show the preview-feature remediation steps.

---

## 4. Projects

### 4.1 Data model (SQLite)
```
projects(id, name, path, kind: 'attached'|'scaffolded', agent: 'claude'|'copilot',
         desktop_pid_hint, created_at, updated_at, settings_json)
sessions(id, project_id, agent, started_at, ended_at, status, baseline_commit_sha)
messages(id, session_id, role, content_json, created_at)          -- reuse upstream shape
annotations(id, session_id, page_name, kind: 'pin'|'rect', x, y, w, h,
            canvas_x, canvas_y, canvas_w, canvas_h, visual_id, visual_type,
            visual_title, text, status: 'draft'|'submitted', created_at)
screenshot_runs(id, project_id, session_id, created_at, pbir_hash, pages_json)
rule_runs(id, project_id, session_id, created_at, ruleset_hash, results_json)
```

### 4.2 Project kinds and PBIP contract
A valid project root contains a `*.pbip` pointer file plus `*.Report/` and (usually) `*.SemanticModel/` folders. On attach, `ProjectService.inspect(path)` must:
1. Locate `*.Report/definition/` — the **PBIR (enhanced) format** marker. If instead only a legacy monolithic `report.json` exists (PBIR-legacy), block attach with guidance: open in Desktop, enable the PBIR enhanced format, Save. All tooling in this spec (report-author validate, Fab Inspector V2 rules, authoring skills) targets PBIR, not PBIR-legacy.
2. Parse report metadata: pages from `definition/pages/pages.json` + per-page folders (`page.json`, `visuals/<id>/visual.json`).
3. Detect semantic model presence and whether the model definition is TMDL (`definition/` with `.tmdl` files) — informational.
4. Initialize git if absent; write a `.gitignore` including Desktop cache/user files and `.zerotwo/screenshots/`.

### 4.3 Project-local state
```
<project>/.zerotwo/
  screenshots/<runId>/<pageName>.png
  rules/               # per-project rule overrides (optional)
  briefs/              # design briefs / report specs produced by planning skill (committed)
  sessions/            # raw agent session logs (gitignored)
  zerotwo.json         # project settings snapshot (committed)
```
`.zerotwo/screenshots` and `.zerotwo/sessions` are gitignored; `briefs/` and `zerotwo.json` are committed.

### 4.4 Attach wizard (PBIX → PBIP guided conversion)
Flow when the user drops/selects a `.pbix`:
1. Ask for a destination folder (default: sibling folder named after the report).
2. Launch Desktop with the file: `powerbi-desktop open "<file>.pbix"`. If a Desktop instance for the file is already running, reuse it (PID from `powerbi-desktop status`).
3. Show a checklist overlay (renderer): (a) In Desktop: File → Options → Preview features → confirm PBIR/enhanced report format enabled if the toggle exists in this build; (b) File → Save As → choose `.pbip` → select the destination folder; (c) wait.
4. Daemon runs a `chokidar` watcher on the destination folder. When `*.pbip` + `*.Report/definition/` appear and file writes settle (debounce ~2s), automatically run `inspect`, create the project, make the baseline commit (`chore: initial import from <name>.pbix`), and advance the wizard to "project ready".
5. Edge cases: user saves to wrong folder (watcher also monitors the pbix's parent as fallback and offers "found a PBIP here — use it?"); Save As produces legacy format (inspect fails with the legacy message → loop back with instructions).

### 4.5 New report scaffolding
`ProjectService.scaffold(name, path)` writes a minimal valid PBIR-format PBIP from an embedded template: `.pbip` pointer, `.Report/definition/` with `report.json`, `version.json`, `pages/pages.json`, one empty page, default theme registration, plus an empty `.SemanticModel` in TMDL format with an empty model (the semantic-model workflows fill it in, §8). Template correctness requirement: after scaffolding, `powerbi-report-author validate <path>.Report` must pass and Desktop must open the `.pbip` without errors. Build the template by generating a blank report in Power BI Desktop once during development, saving as PBIP, and committing a sanitized copy under `fixtures/` + embedded template assets — do not hand-write PBIR JSON from memory.

---

## 5. Agent layer

### 5.1 Adapter contract
Keep the upstream adapter interface. Both adapters must support: spawn with `cwd = project.path`, streaming stdout parse to normalized events (text delta, tool use, file change notice, done/error), session resume where the CLI supports it, and cancel (tree-kill). Permission posture: run the CLI in its "accept file edits within cwd" mode; never grant network/system-level auto-approval. Surface every tool action in the chat transcript.

### 5.2 Subscription-only auth
- Claude Code: detect login via the CLI's auth/status mechanism; if not logged in, open a terminal window running `claude` login flow (or `claude /login`) and poll status. Never write `ANTHROPIC_API_KEY` into any environment or config; actively strip it from the spawn env if present in the parent environment, so subscription auth is always used.
- Copilot CLI: same pattern with its GitHub device-code login.
- The Settings screen shows per-agent: installed?, version, logged in as, and a "Sign in" button that launches the interactive flow.

### 5.3 Skill/plugin provisioning (per project, per agent)
On project creation (and re-runnable via "Re-provision" button), `ProvisioningService` executes, inside the chosen CLI in the project directory, the plugin-marketplace flow both CLIs share:

1. Add marketplaces:
   - `microsoft/skills-for-fabric` (marketplace name `fabric-collection`) — https://github.com/microsoft/skills-for-fabric
   - `data-goblin/power-bi-agentic-development` (community marketplace) — https://github.com/data-goblin/power-bi-agentic-development
2. Install plugins:
   - `powerbi-authoring@fabric-collection` — brings powerbi-report-planning, powerbi-report-design, powerbi-report-authoring, powerbi-report-management skills, semantic-model-authoring skill, and registers the **Power BI Modeling MCP server** automatically.
   - From the community marketplace, **pinned to release 26.25** (26.26 is a breaking reorganization): the PBIP/PBIR plugin (deterministic PBIR/TMDL validation hooks), the Desktop plugin (DAX/measure integrity hooks), the reports plugin (Deneb/Vega-Lite + SVG visuals + theming skills), and the DAX plugin. Exact plugin names must be read from that repo's README at implementation time — do not guess; if names changed, choose the closest current equivalents covering: PBIR validation hooks, Deneb/Vega-Lite, DAX.
3. Verify: list installed plugins/skills via the CLI, assert the expected set, and record `{plugin, version}` into `zerotwo.json`. Show a provisioning report in the UI.
4. Provisioning is orchestration only — Zero Two never vendors or redistributes skill files from either upstream repo; they are installed from source into the user's agent. This keeps updates flowing and avoids maintaining copies.

Implementation detail: plugin commands are slash commands inside the CLI REPL. Drive them via each CLI's non-interactive/print mode if it supports executing slash commands (verify per CLI at build time); otherwise drive a PTY (e.g. `node-pty`) and script the REPL. Encapsulate in `ProvisioningService` with per-CLI strategies.

### 5.4 Project agent context (ZERO_TWO.md)
Scaffold/attach writes a `ZERO_TWO.md` (and links it from `CLAUDE.md` / `AGENTS.md` so both CLIs load it) containing the standing contract for agents:
- The iteration-loop contract (§6.3): validate after every logical batch; then Zero Two runs inspection, reload, screenshots — the agent must read the screenshot review results before claiming completion.
- File-scope rule: only modify files under the project root; never touch `.zerotwo/` except reading screenshots/briefs.
- Comment-mode prompt format definition (§9.4) so the agent knows how to interpret pin blocks (prefer visual IDs over raw coordinates; coordinates are in report canvas units).
- Model-work routing: semantic model changes go through the Modeling MCP server when Desktop is running; TMDL file edits are the fallback; never edit model metadata by rewriting PBIR files.
- PBIR-is-source-of-truth warning: the user must save Desktop changes before agent sessions.

---

## 6. Orchestrated iteration loop

### 6.1 Session lifecycle
Starting a session: (1) warn if Desktop has the project open with unsaved changes (best effort: bridge state if exposed; otherwise always show a passive reminder), (2) `git add -A && git commit` baseline (`chore(session): baseline before agent session <id>`), (3) spawn adapter.

### 6.2 Loop stages (daemon `PipelineService`)
After every agent turn that changed files under `*.Report/` or `*.SemanticModel/` (detect via chokidar + git status), run the pipeline and stream stage events to the renderer:
```
validate  -> powerbi-report-author validate <Report dir>        (structural)
inspect   -> fab-inspector CLI with the user's active ruleset   (policy)
reload    -> powerbi-desktop reload [--report-only by default]  (render)
screenshot-> powerbi-desktop screenshot-all -> .zerotowo run dir (capture)
commit    -> git commit (message: agent summary, session id)    (safety)
```
- Reload defaults to report-only; a "reload with model" toggle exists for sessions that changed the model (auto-suggested when `.SemanticModel/` files changed).
- Stage results are SSE events: `pipeline:stage` `{stage, status, detail}` and `screenshots:updated` `{runId, pages[]}`.
- Failure policy: `validate` failure → feed the validator output back to the agent automatically as a corrective message (max 3 auto-retries, then surface to user). `inspect` failures do **not** auto-block; results render in the Rules panel with a per-run "Ask agent to fix" button (user-triggered, sends failing rule results as a prompt). `reload`/`screenshot` failure → Doctor-style remediation banner (bridge down, Desktop closed, PID ambiguity → PID picker from `powerbi-desktop status`).

### 6.3 Loop contract with the agent
The agent-side loop (edit → validate → reload → screenshot → review) is already encoded in the Microsoft report-authoring skill. Zero Two's pipeline is the *external* guarantee that runs regardless of agent behavior. To avoid double reloads, ZERO_TWO.md instructs the agent NOT to call `powerbi-desktop reload`/`screenshot` itself — Zero Two runs those and places fresh screenshots at a stable path (`.zerotwo/screenshots/latest/`, a junction/copy of the newest run) which the agent reads for its visual review step. `validate` remains agent-invoked (per skill) *and* pipeline-invoked (idempotent).

### 6.4 Desktop session management
`DesktopService` wraps the bridge CLI: `status` (instances + PIDs), `open <pbip>`, `reload`, `screenshot-all --out <dir>` with configurable resolution (default 1600px width equivalent; make resolution a setting). Persist the matched PID per project (`desktop_pid_hint`); on mismatch/multiple instances, emit a `desktop:pick_instance` event → renderer shows a picker. Re-run `powerbi-desktop manifest` on daemon start and cache the capability list; degrade gracefully (hide screenshot features with a warning) if methods are missing after a Desktop update.

---

## 7. Preview

The renderer's center pane shows the latest screenshot run: page tabs (from `pages.json` display names, respecting page order and hidden flags), a zoom/pan canvas per page, a staleness indicator (hash of `*.Report/definition/**` at capture time vs now), and a manual "Refresh preview" button (runs reload+screenshot stages only). Screenshots are served by the daemon (`GET /api/projects/:id/screenshots/:runId/:page.png`).

---

## 8. Semantic model workflows

Model capability is first-class in v1: the tool must create semantic models, DAX measures/KPIs, and audit model quality.

### 8.1 Plumbing
The Modeling MCP server is registered by the powerbi-authoring plugin (§5.3) and connects to: the model open in Power BI Desktop (preferred when the project is open in Desktop), a PBIP's TMDL files, or Fabric — Fabric mode is out of scope/disabled in v1 guidance. The MCP server's elicitation confirmations (approval before first modification / first query) must surface in the chat UI as approval prompts, not be auto-skipped: never pass its skip-confirmation option.

### 8.2 Workflows (exposed as UI entry points that compose prompts; execution is always via the agent + skills/MCP)
1. **Model builder** (new projects): user describes sources/grain/KPIs → semantic-model-authoring skill plans a star schema → approval gate → agent builds TMDL/model via MCP → pipeline runs with model reload.
2. **DAX/KPI factory**: user requests measures/KPIs in chat; DAX skill + MCP validate by executing DAX queries; results echoed in chat.
3. **Model audit** ("flag bad semantic setup"): a one-click action running the semantic-model-authoring skill's best-practices/AI-readiness analysis. The agent is instructed (via the action's prompt template) to output findings as a fenced JSON block `zerotwo:findings` with `{id, severity: 'error'|'warning'|'info', object, description, autoFixable: bool}`. Renderer parses this into a Findings panel with per-finding checkboxes → "Apply selected fixes" sends a structured follow-up prompt listing approved finding IDs. (Parsing is best-effort; if the block is absent, render the raw markdown.)

---

## 9. Comment mode (pin annotations on screenshots)

### 9.1 UX contract (see design spec for visuals)
On any preview page the user toggles comment mode, then: click to drop a point pin, or drag to draw a rectangle; each annotation opens a text field; multiple annotations accumulate in a side list; "Send to agent" submits the whole batch as one prompt. Annotations persist per session (drafts survive app restart).

### 9.2 Coordinate mapping
PBIR positions visuals in report canvas units. For page dimensions read `page.json` (`width`, `height`). Screenshot pixel → canvas mapping: `scale = pageWidthUnits / screenshotWidthPx` (uniform; verify aspect ratio matches and log a warning if not). Store both raw screenshot px and computed canvas coordinates on the annotation.

### 9.3 Visual hit-testing
`AnnotationService.resolve(page, canvasX, canvasY [, w, h])`:
1. Load all `visuals/*/visual.json` for the page; extract `{id, x, y, width, height, z, visualType, title/displayName if present, isHidden}` — field names must be verified against real PBIR fixtures at build time (positions live in the visual's `position` object in PBIR).
2. Point pin: candidates = visuals whose bounds contain the point; pick highest `z` (topmost). Rectangle: candidates = visuals intersecting the rect, ordered by intersection area.
3. If no hit, return nearest visual by edge distance with `matched: 'nearest'` flag, plus the raw coordinates.
4. Return `{visualId, visualType, visualTitle, matchKind}` and store on the annotation; show the match in the pin UI so the user can see (and correct via a dropdown of the page's visuals) what was hit.

### 9.4 Prompt synthesis (single batch)
```
## Zero Two visual annotations — page "<Page display name>" (page file: <name>)
The user reviewed the latest rendered screenshot and left the following annotations.
Coordinates are in report canvas units. Prefer targeting visuals by id.

1. [pin @ (x=612, y=88)] -> visual id=<guid> type=cardVisual title="Revenue Won" (match: contains)
   User: "Move this KPI up so it aligns with the others"
2. [rect (x=40, y=400, w=520, h=180)] -> visual id=<guid> type=tableEx title="Opportunities" (match: intersects, 92%)
   User: "This table is too cramped, give it more breathing room and larger row height"

Apply all changes, then run validation. Zero Two will re-render automatically.
```
Submitting flips annotations to `submitted`, sends the block as a user message into the active session, and the pipeline (§6.2) takes over. After the next screenshot run, submitted pins render as resolved markers (dimmed) until dismissed.

---

## 10. Rules Studio (Fab Inspector)

### 10.1 Storage and scope
- User rules: `%APPDATA%/ZeroTwo/rules/<ruleset>.json` (Fab Inspector JSON-Logic rules files).
- Optional per-project override/extension: `<project>/.zerotwo/rules/`.
- **No rules ship enabled.** First-run Rules Studio shows an empty state with "Create your first rule". A template gallery (common patterns: max visuals per page, hidden tooltip/drillthrough pages, theme-color conformity, no custom colors off-theme, axis titles required) is available, but templates only become rules when the user explicitly creates from one — this satisfies "rules are defined by the user, none shared by default".

### 10.2 Editor
Two modes per rule: (a) form builder for templated rule shapes (name, description, severity, parameters), which generates the JSON-Logic rule; (b) raw JSON editor with schema-aware linting (validate against Fab Inspector's rules format; at minimum JSON-parse + required-field checks). Every rule has enable/disable and a "Test against current project" button → runs Fab Inspector for just that rule and shows results inline, including its wireframe/failing-visual output when available.

### 10.3 Execution
`InspectionService` runs the Fab Inspector CLI against the project's `*.Report` folder with the merged active ruleset (user + project), parses CLI output (prefer its machine-readable output format if available; otherwise parse console output — verify at build time), stores `rule_runs`, and emits results to the Rules panel: per-rule pass/fail, failing pages/visuals, severity. Panel actions: "Ask agent to fix" (per rule or all failures → structured prompt), "Re-run".

Note: Fab Inspector V2 supports the PBIR format only — consistent with §4.2's PBIR requirement.

---

## 11. Git integration

- `GitService` uses a bundled library (`simple-git` or `isomorphic-git`) — no reliance on repo GUI tools.
- Auto: init on attach/scaffold; baseline commit per session; post-pipeline commit per iteration with message `zerotwo: <agent turn summary, truncated> [session <id>]`.
- UI: a History panel listing commits for the project with per-commit "Restore" (hard reset with confirm + safety stash) and a lightweight file-diff viewer (reuse any upstream diff component; otherwise render unified diffs from `git diff`).
- Remote: Settings per project allows adding a remote URL and Push (plain `git push`, auth is the user's ambient git credential manager). Not required for any flow.

---

## 12. Daemon API surface (renderer contract)

REST + SSE (keep upstream conventions; extend):
```
GET  /api/doctor
POST /api/projects            {kind, path|pbixPath, name, agent}
GET  /api/projects/:id        (incl. pages, provisioning report, desktop status)
POST /api/projects/:id/provision
POST /api/projects/:id/sessions              -> starts agent session
POST /api/sessions/:id/messages              -> user chat message
POST /api/sessions/:id/annotations           -> create/update pins
POST /api/sessions/:id/annotations/submit    -> batch submit (returns synthesized prompt)
POST /api/projects/:id/pipeline/run          {stages?: [...]}   -> manual refresh etc.
GET  /api/projects/:id/screenshots/:run/:page.png
GET/POST/PUT/DELETE /api/rules ...           -> Rules Studio CRUD
POST /api/rules/:id/test      {projectId}
GET  /api/projects/:id/history               -> git log
POST /api/projects/:id/restore {sha}
SSE  /api/stream              -> chat deltas, pipeline:stage, screenshots:updated,
                                 desktop:pick_instance, findings, rules:results
```

---

## 13. Security posture

- Local-first: the only network traffic originates from the agent CLIs themselves (their subscription auth + model calls), npm/plugin installs from GitHub, and git push if user-configured. Zero Two makes no other outbound calls.
- No secrets stored: no API keys (forbidden entirely), no data-source credentials (Desktop owns those), no tokens. `%APPDATA%/ZeroTwo/config.json` holds only tool paths and preferences.
- Agent blast radius: cwd-scoped edit permissions; ZERO_TWO.md scope rule; git baseline before every session; Restore in UI. Optionally adopt the community marketplace's defensive hooks if compatible with the pinned release.
- MCP elicitation confirmations always surfaced (§8.1), never skipped.

---

## 14. Implementation plan

The plan is written to be executed top-to-bottom by Claude Code without prior manual experimentation on the target machine; every phase ends with automated checks plus a short "manual verification on Windows" checklist that the team runs when convenient. Where this spec says "verify at build time", resolve it by reading the upstream README/source in the same phase, and record the resolution in `docs/ARCHITECTURE.md`.

### Phase 0 — Fork & strip (repo bootstrap)
- Fork open-design → akoppcode/ZeroTwo; produce `docs/UPSTREAM-MAP.md`; strip per §2.2; rename identifiers; ensure `npm run dev` boots shell+daemon+renderer with an empty project list; set up GitHub Actions CI (typecheck, lint, unit tests on windows-latest).
- Acceptance: clean boot on Windows CI; only claude/copilot adapters remain; no API-key UI remains.

### Phase 1 — Environment services & Doctor
- `EnvironmentService`, `scripts/setup.ps1`, `scripts/doctor.ps1`, Doctor screen. Mock-based unit tests: fake executables on PATH simulating each CLI (`fixtures/mock-bin/`), version matrices, failure remediation strings.
- Acceptance: doctor correctly classifies all matrix cases in tests; manual checklist: real machine passes with Desktop 2.155+.

### Phase 2 — Projects: attach, scaffold, inspect, git
- `ProjectService`, PBIP inspection (PBIR vs legacy detection, page/visual parsing), scaffolding template (built from a real Desktop-generated blank PBIP committed to fixtures), `GitService`, attach wizard backend (watchers) + wizard UI.
- Acceptance: attaching `fixtures/sample.pbip` yields correct page/visual inventory; scaffolded project passes `powerbi-report-author validate` (run in CI via the real CLI if installable headlessly on windows-latest, else behind an integration flag); legacy-format fixture is rejected with guidance.

### Phase 3 — Agent adapters, subscription auth, provisioning
- Port/verify both adapters against current CLI versions; auth detection + guided login; `ProvisioningService` (PTY-driven slash commands or non-interactive mode — resolve per CLI, document in ARCHITECTURE.md); provisioning report UI; ZERO_TWO.md generation.
- Acceptance: with mock CLIs, provisioning issues the exact expected command sequences (marketplace add ×2, installs, pinned version) and parses verification output; chat round-trip works against mock adapters; env-var stripping test proves `ANTHROPIC_API_KEY` never reaches child processes.

### Phase 4 — Desktop bridge & pipeline
- `DesktopService` (status/open/reload/screenshot-all/manifest, PID handling), `PipelineService` with stage events, file watchers, auto-retry-on-validate-failure, commit stage; preview pane (page tabs, zoom, staleness).
- Acceptance: full pipeline runs green against mock bridge CLI producing fixture PNGs; SSE stage events render as a stepper; PID-ambiguity path shows picker. Manual checklist: real Desktop loop on the team machine (reload latency, focus behavior, minimized-window rendering — record findings in docs).

### Phase 5 — Comment mode
- Annotation canvas (pins + rectangles, list, drafts persistence), coordinate mapping, `AnnotationService.resolve` hit-testing against real PBIR fixtures, prompt synthesis, submitted/resolved lifecycle.
- Acceptance: unit tests for mapping math and hit-testing (contains, intersect-area ordering, nearest fallback, z-order); golden-file test for the synthesized prompt block; e2e (mocked agent): pins → prompt → pipeline → pins marked resolved.

### Phase 6 — Rules Studio
- Rules CRUD + storage, form builder for the template gallery, raw JSON editor with linting, `InspectionService` CLI integration + output parsing (resolve output format from Fab Inspector docs in this phase), Rules panel with per-run results and "Ask agent to fix".
- Acceptance: a user-authored rule (max visuals per page) fails on a fat fixture and passes on the slim one, end-to-end through the CLI (integration flag) and through a recorded-output mock in CI.

### Phase 7 — Semantic model workflows
- Model builder and audit entry points, findings JSON-block parsing + Findings panel + apply-fix flow, model-reload toggle wiring, MCP elicitation surfacing in chat.
- Acceptance: findings parser handles well-formed/malformed blocks; prompts templates snapshot-tested; manual checklist: real audit run against a fixture model in Desktop.

### Phase 8 — Packaging & docs
- electron-builder NSIS installer (per-user, no admin), app icon/branding, `README.md` (team onboarding: run setup.ps1 → install app → sign in to agent → attach first report), `docs/ARCHITECTURE.md` finalized, GitHub Release workflow producing the installer artifact. No auto-update in v1 (small team; releases via GitHub).
- Acceptance: CI builds a signed-or-unsigned installer artifact; fresh-VM manual checklist documented.

### Cross-cutting testing strategy
- **Mock CLI harness**: `fixtures/mock-bin/` contains Node scripts emulating `powerbi-desktop`, `powerbi-report-author`, fab-inspector, `claude`, `copilot` with scenario control via env vars. All CI runs use mocks; a `ZT_INTEGRATION=1` mode switches services to real binaries for on-machine runs.
- **Fixtures**: one minimal PBIR PBIP (2 pages, ~6 visuals, small TMDL model), one legacy-format sample (rejection tests), one "fat" page fixture (rules tests). Generate from real Desktop once; commit sanitized.
- **Golden files** for: synthesized annotation prompts, provisioning command sequences, ZERO_TWO.md output.

### Known risks (track in issues from day one)
1. Bridge/CLIs are preview: method surface may shift per Desktop release → manifest re-check + capability gating (§6.4).
2. Community marketplace 26.26 breaking reorg → hard pin 26.25; schedule an upgrade spike.
3. Non-interactive slash-command support may differ between CLIs → PTY fallback is the contingency (Phase 3).
4. Screenshot rendering with minimized Desktop window is unverified → Phase 4 manual checklist; if broken, document "keep Desktop on a secondary virtual desktop" in onboarding.
5. PBIR field-name drift (visual.json position schema) → all parsing goes through one `pbir-parse` module with fixture-locked tests.
