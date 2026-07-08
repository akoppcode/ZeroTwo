# fixtures/mock-bin

Env-var-driven fake CLIs that emulate the external tools Zero Two probes, so the
environment/Doctor checks and (later) the pipeline can be tested without the real
Power BI Desktop bridge, authoring CLI, Fab Inspector, or agent CLIs installed.

Each fake is a Node ES module (`.mjs`) that reads scenario control from `ZT_MOCK_*`
environment variables and emulates the real tool's output for the commands the
daemon invokes. They emulate a **present** tool in various states; a *missing*
tool is simulated by simply not putting the fake on the runner's path (the daemon
sees `notFound`).

Per the cross-cutting testing strategy (spec §14), CI drives these mocks; a real
run switches to the real binaries.

## Fakes and their scenario env vars

| Fake | Emulated tool | Commands | Env control (default) |
|---|---|---|---|
| `powerbi-desktop.mjs` | `@microsoft/powerbi-desktop-bridge-cli` | `--version`, `status`, `manifest` | `ZT_MOCK_PBID_VERSION` (`1.2.3`), `ZT_MOCK_PBID_STATUS` (`connected`) — set to `not_connected` for the not-connected path |
| `powerbi-report-author.mjs` | `@microsoft/powerbi-report-authoring-cli` | `--version`, `validate` | `ZT_MOCK_REPORT_AUTHOR_VERSION` (`1.0.0`), `ZT_MOCK_REPORT_AUTHOR_VALIDATE` (`ok` / `fail`) |
| `fab-inspector.mjs` | Fab Inspector (PBI Inspector V2) | `--help` | `ZT_MOCK_FAB_INSPECTOR_VERSION` (`2.0.0`) |
| `claude.mjs` | Claude Code CLI | `--version`, `auth status` | `ZT_MOCK_CLAUDE_VERSION` (`claude-code 1.0.0`), `ZT_MOCK_CLAUDE_LOGGED_IN` (`1`), `ZT_MOCK_CLAUDE_USER` (`consultant@example.com`) |
| `copilot.mjs` | GitHub Copilot CLI | `--version`, `auth status` | `ZT_MOCK_COPILOT_VERSION` (`copilot 1.0.0`), `ZT_MOCK_COPILOT_LOGGED_IN` (`1`), `ZT_MOCK_COPILOT_USER` (`octocat`) |

`ZT_MOCK_CLAUDE_LOGGED_IN=0` makes `auth status` exit non-zero with a "Not logged
in" message; the daemon's agent check classifies that as a warning.
