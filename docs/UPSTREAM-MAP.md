# UPSTREAM-MAP — open-design → Zero Two

Survey of the upstream repository (nexu-io/open-design, forked at `main` = `c3712b738`) as required by
ZERO-TWO-IMPLEMENTATION-SPEC.md §2.1. All paths are repo-relative; line numbers refer to the fork point
and will drift as the strip progresses.

Upstream is a pnpm monorepo (`open-design` v0.12.1, `packageManager pnpm@10.33.2`, Node ~24, ESM,
Apache-2.0). Workspace globs (`pnpm-workspace.yaml`): `packages/*`, `apps/*`, `tools/*`, `e2e`.

---

## 1. The local daemon (HTTP + SQLite + SSE)

**Package:** `apps/daemon` (`@open-design/daemon`). Express 5 server, `better-sqlite3` persistence,
SSE streaming, MCP SDK, node-pty terminals. CLI wrapper: `apps/daemon/bin/od.mjs` → `src/cli.ts` → `src/server.ts`.

- **HTTP server:** `apps/daemon/src/server.ts` (~8 000 lines; also contains the run executor).
  `const app = express()` at `server.ts:1951`; listens at `server.ts:7989`; default port **7456** (`server.ts:1915`).
- **Route registration:** modular registrars in `apps/daemon/src/routes/` imported at `server.ts:562-584`
  (`chat.ts`, `runs.ts`, `terminal.ts`, `media.ts`, `live-artifact.ts`, `routes/project/*`, `routes/plugins/*`, …).
  Typed route contract: `apps/daemon/src/http/adapter.ts` (`defineJsonRoute`/`mountJsonRoute`).
- **SQLite:** `better-sqlite3@12.10.0`. Main module `apps/daemon/src/db.ts` (`openDatabase()` :33,
  schema in `migrate()` :55). Core tables: `projects` (:57), `templates` (:68), `conversations` (= chat
  sessions, :77), `agent_sessions` (per-conversation CLI resume handles: session_id/model/cwd, :90),
  `messages` (:110), `preview_comments` (:137), `tabs`/`tabs_state`, `deployments`, `routines`.
  Feature tables migrate from sibling modules (`critique/persistence.ts`, `library-store.ts`,
  `media/tasks.ts`, `plugins/persistence.ts`, `registry/database-backend.ts`).
- **SSE:** helper `createSseResponse` at `server.ts:1823`; primary stream `GET /api/runs/:id/events`
  (`routes/runs.ts:1323`), AG-UI variant `GET /api/runs/:id/agui` (`routes/runs.ts:1331`).
- **Data dir:** default `.od` (`apps/daemon/src/app-config.ts:158`, `db.ts:34`), overridable via `OD_DATA_DIR`;
  packaged builds resolve it under the Electron userData namespace (`apps/packaged/src/paths.ts`).

**Zero Two verdict: KEEP** (spec §2.3 — daemon skeleton, HTTP + SSE + SQLite, project/chat persistence).

## 2. Agent adapter layer

- **Contract:** `type RuntimeAgentDef` in `apps/daemon/src/runtimes/types.ts:95`
  (`id`, `bin`, `buildArgs()`, `streamFormat`, `eventParser`, `promptViaStdin`, `env`, `authProbe`,
  session-resume flags). Re-exported via `apps/daemon/src/agents.ts`.
- **Registry/factory:** `apps/daemon/src/runtimes/registry.ts` — def imports (:1-25),
  `BASE_AGENT_DEFS` (:29-55), `AGENT_DEFS` (:63), `getAgentDef(id)` (:76). User "local profiles"
  (`runtimes/local-profiles.ts`) can add runtime-defined adapters.
- **Adapters at fork point (26):** one def per file under `apps/daemon/src/runtimes/defs/`:
  amr(vela), claude, codex, devin, opencode, byok-opencode, hermes, trae-cli, grok-build, kimi,
  cursor-agent, qwen, qoder, copilot, amp, pi, kiro, kilo, vibe, deepseek, aider, antigravity,
  reasonix, codebuddy, mimo (+ `defs/shared.ts` helpers).
  **Zero Two keeps `claude` and `copilot` only** (spec §2.2).
- **Spawn (cwd handling):** run executor `startChatRun` at `server.ts:3929`; actual
  `spawn(command, args, { env, cwd: effectiveCwd, shell:false, … })` at `server.ts:5875`;
  `effectiveCwd = cwd ?? PROJECT_ROOT` at `server.ts:4353` — per-project dir is the working directory.
  Env composition: `runtimes/env.ts` (`spawnEnvForAgent`) applied at `server.ts:5758`.
- **Stream parsing (per streamFormat, dispatched from `server.ts:6553+`):**
  - `claude-stream-json` → `runtimes/claude-stream.ts` (**KEEP**)
  - `copilot-stream-json` → `src/copilot-stream.ts` (**KEEP**)
  - `qoder-stream-json` → `runtimes/qoder-stream.ts`; `pi-rpc` → `src/pi-rpc.ts`;
    `acp-json-rpc` → `src/acp.ts`; `json-event-stream` → `runtimes/json-event-stream.ts`
    (codex/opencode/cursor/gemini parsers) — all only used by removed adapters (**STRIP**).
- **Auth detection:** `apps/daemon/src/runtimes/auth.ts` — per-CLI failure classifiers
  (`isClaudeAuthFailureText` :141), active probes (`probeAgentAuthStatus` :357, run from
  `runtimes/detection.ts`). Probe short-circuits when an API key env is present
  (`hasProbeSatisfyingApiKey` :323) — **this short-circuit is removed; Zero Two is subscription-only (spec §5.2)**.
- **Per-agent env allowlists:** `apps/daemon/src/app-config.ts:196-224` — claude allowlist includes
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; codex includes `OPENAI_API_KEY`. API-key entries are
  removed in Phase 0 (UI/storage) and env stripping is hardened with tests in Phase 3.

## 3. Electron shell + renderer

- **Electron main process:** `apps/desktop` (`@open-design/desktop`), source `src/main/index.ts`
  (+ `runtime.ts` window chrome/URL allowlist, `updater.ts`, `preload.cts`, `diagnostics.ts`,
  `pdf-export.ts`, `deck-capture.ts`). Electron 41.
- **Packaged launcher:** `apps/packaged` (`@open-design/packaged`) — boots daemon+web sidecars for
  shipped builds (`src/launch.ts`, `src/sidecars.ts`, `src/protocol.ts` — `od://` scheme,
  `src/window-title.ts`, `src/paths.ts` userData naming).
- **Renderer:** `apps/web` (`@open-design/web`) — **Next.js 16** app router, React 18, Tailwind 4.
  Dev = `next dev --turbopack`; CLI build = static export served by the daemon; packaged desktop sets
  `OD_WEB_OUTPUT_MODE=server` (SSR sidecar). Talks to the daemon by **proxying `/api`, `/artifacts`,
  `/frames` to `http://127.0.0.1:${OD_PORT||7456}`** (`apps/web/next.config.ts:11-24`).
  Live transport is **SSE** (EventSource), not WebSocket.
- **electron-builder config is code-generated, not a static file:** `tools/pack/src/*` —
  appId `io.open-design.desktop` (+ channel variants) and productName "Open Design" originate in
  `packages/release/src/index.ts:54-114` and are wired through `tools/pack/src/{mac,win,linux}`.
- **Dev boot:** there is intentionally **no root `dev` script**. `pnpm tools-dev` (`tools/dev/src/index.ts`)
  is the only lifecycle entry point; it spawns daemon/web/desktop sidecars (`@open-design/sidecar`,
  `packages/sidecar-proto` `APP_KEYS = {daemon,desktop,web}`). Zero Two keeps this and treats the spec's
  "`npm run dev`" as `pnpm tools-dev`.

**Zero Two verdict: KEEP** shell, packaged launcher, renderer chrome + chat UI, sidecar tooling.

## 4. Project/workspace registry and chat/session persistence

- **DB layer:** `apps/daemon/src/db.ts` — `listProjects` :600, `insertProject` :798, `updateProject` :818,
  `deleteProject` :849; conversations :981-1227; messages :1373-1588.
- **Filesystem service:** `apps/daemon/src/projects.ts` (`projectDir` :61, `createProjectFolder` :173,
  path sanitization :1372-1505) + `project-locations.ts`, `project-root.ts`, `project-watchers.ts`,
  `project-file-versions.ts`, `linked-dirs.ts`; HTTP routes under `routes/project/*`.
- **Agent session resume:** table `agent_sessions`; logic in `apps/daemon/src/agent-session-resume.ts`
  (`resolveAgentResumeContext` :80, `persistCapturedAgentSession` :132, `isClaudeResumeFailure` :246).

**Zero Two verdict: KEEP** — becomes the base for spec §4.1's schema (extended with annotations,
screenshot_runs, rule_runs in later phases).

## 5. Preview mechanism (removed and replaced, spec §7)

Upstream previews artifacts in a **sandboxed `<iframe>`** pointed at daemon endpoints:
- Web: `apps/web/src/components/FileViewer.tsx` (iframe :1336, `previewUrl` :1484),
  `PreviewModal.tsx`, `IframeKeepAlivePool.tsx`, `PreviewDrawOverlay.tsx`;
  URL built by `liveArtifactPreviewUrl` (`apps/web/src/providers/registry.ts:1620`).
- Daemon: `apps/daemon/src/routes/live-artifact.ts` (`GET /api/live-artifacts/:id/preview` :34),
  static `/artifacts` mount `server.ts:2922`, `/frames` `server.ts:2953`.

**Zero Two verdict: STRIP** — replaced by the screenshot-run preview (Desktop Bridge, spec §6/§7).
The daemon static-serving pattern (`/artifacts`) is the model for serving `.zerotwo/screenshots/`.

## 6. Strip map (spec §2.2) — feature → location

| Feature (strip) | Locations |
|---|---|
| Image/video/audio generation ("media") | `apps/daemon/src/media/` (engine, ~4 100-line dispatcher; providers openai/fal/volcengine/grok/…), `apps/daemon/src/media-adapters/`, `apps/daemon/src/routes/media.ts`, `apps/daemon/src/prompts/media-contract.ts`, `apps/daemon/src/integrations/{aihubmix,elevenlabs-voices,google-models,provider-models}.ts`, `apps/web/src/media/`, media sections of `apps/web/src/components/SettingsDialog.tsx`, `prompt-templates/` |
| Slide/deck features | `apps/daemon/src/deck-export.ts`, `apps/daemon/src/prompts/deck-framework.ts`, `apps/daemon/src/qa/deck-layout.ts`, `apps/daemon/src/brands/engine/artifacts/deck.ts`, `apps/desktop/src/main/deck-capture.ts`, deck templates in `templates/` |
| Landing page | `apps/landing-page/` (Astro marketing site), its 4 CI workflows, `vercel.json` |
| Design-system/template catalogs | `design-systems/` (152 entries), `design-templates/` (113), loaders in `apps/daemon/src/design-systems/`, routes in `routes/static-resource.ts` + `routes/design-systems.ts`, web catalog UI (`DesignSystemsTab.tsx`, `DesignKitView.tsx`, `PromptTemplatesTab.tsx`, `ExamplesTab.tsx`, …), guard `scripts/check-design-system-manifests.test.ts` |
| Agent adapters except claude/copilot | 24 defs under `runtimes/defs/`, registry entries (`registry.ts:1-55`), env allowlists (`app-config.ts:196-224`), tailored auth classifiers (`runtimes/auth.ts`), stream handlers `qoder-stream.ts`/`pi-rpc.ts`/`acp.ts`/`json-event-stream.ts` + their `server.ts` dispatch branches, per-agent mocks in `mocks/`, e2e specs |
| iframe preview | see §5 |
| BYOK API-key UI + storage | `apps/web/src/components/byok/` (`ByokKeyField.tsx` et al.), BYOK/media-key sections of `SettingsDialog.tsx` (8 459 lines — surgical), `apps/daemon/src/byok-tools.ts` (1 690 lines), `runtimes/defs/byok-opencode.ts`, API-key fields of `app-config.ts` (`agentCliEnvIntent.apiKeyOverride`, key allowlists), `media/config.ts` key storage (`.od/media-config.json`), connection-test surface (`connectionTest.ts`, `packages/contracts/src/api/connectionTest.ts`) |
| Telemetry | `apps/telemetry-worker/` (spec §1: no telemetry) |

**Zero-code-reference auxiliaries (safe deletes):** `charts/` (Helm), `clipper/` (browser extension),
`figma-plugin/`, `story/`, `.vaunt/`, `deploy/` (Docker/AWS/Azure), `nix/` + `flake.nix` + `flake.lock`,
`vercel.json`. Caveat: `craft/` and `skills/` are loaded by the daemon at runtime and guarded by
`pnpm guard` tests — handled with the catalog strip, not as blind deletes.

**Keep (spec §2.3):** daemon skeleton (HTTP+SSE+SQLite), claude/copilot adapters + stream parsers,
chat UI with streaming, project registry, settings persistence, Electron packaging setup
(`tools/pack`, `tools/dev`, `packages/sidecar*`).

## 7. Rename checklist (→ Zero Two, `com.akoppcode.zerotwo`)

Must-rename (identifiers/config):
- Root `package.json` name (`open-design` → `zerotwo`), bin `od` → `zerotwo`.
- All 20 workspace package names `@open-design/*` → `@zerotwo/*` (+ every `workspace:*` dep and import — ~644 files, mechanical).
- `packages/release/src/index.ts:54-114`: `PRODUCT_NAME` "Open Design" → "Zero Two",
  `DEFAULT_NAMESPACE` `open-design` → `zerotwo`, appId `io.open-design.desktop` → `com.akoppcode.zerotwo` (+ channel variants); its tests.
- `tools/pack/src/{win,linux,mac}` appId/productName wiring; icons under `tools/pack/resources/` (asset swap deferred to Phase 8 branding).
- Protocol scheme `od://` (`apps/packaged/src/protocol.ts:3`) → `zerotwo://`; MCP resource URIs (`apps/daemon/src/mcp.ts`).
- Window title (`apps/packaged/src/window-title.ts:7`), userData dir names (`paths.ts:110`).
- `.claude-plugin/marketplace.json`, `plugins/open-design/` dir.
- `nexu-io/open-design` repo slugs embedded in runtime code (`cli.ts` fork/issue URLs, `design-systems/index.ts:1638`, `import-export-routes.ts:1006`).
- In-product "Open Design" strings (~433 .ts/.tsx files) — mechanical replace.

Deliberately NOT renamed in Phase 0 (internal, zero user impact; documented debt):
- `OD_*` env-var prefix (`OD_PORT`, `OD_DATA_DIR`, …) — pervasive across daemon/tools/sidecars; renaming is high-risk churn with no product value. Revisit only if it ever leaks into user-facing docs.
- `.od` daemon data-dir name — becomes `%APPDATA%/ZeroTwo` as part of Phase 1 (EnvironmentService owns config paths per spec §3).

## 8. CI at fork point

44 workflows under `.github/workflows/` (Linux-heavy: ubuntu-24.04 + self-hosted + blacksmith runners;
one windows-latest leg for pack tests; release matrices; many bots). All replaced in Phase 0 by a single
`ci.yml` on **windows-latest** (typecheck, guard/lint, unit tests, daemon boot smoke) per spec §14 Phase 0.

Root commands: `pnpm typecheck` (workspace-wide tsc), `pnpm guard` (repo policy tests under `scripts/`),
per-package `test` = vitest. No root ESLint; guard suite is the lint gate.
