import type { ExecFileOptions } from 'node:child_process';
import type { AgentDiagnostic } from '@open-design/contracts';

export type { AgentDiagnostic } from '@open-design/contracts';

export type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string>;

export type RuntimeModelOption = {
  id: string;
  label: string;
  inputPriceUsdPerMillion?: number;
  outputPriceUsdPerMillion?: number;
};

export type RuntimeModelSource = 'live' | 'fallback';

export type RuntimeReasoningOption = RuntimeModelOption;

export type RuntimeBuildOptions = {
  model?: string | null;
  reasoning?: string | null;
};

export type RuntimeContext = {
  cwd?: string;
  // Daemon-owned path to a temp file containing the composed prompt.
  // Adapters with `promptViaFile: true` read this instead of receiving
  // the prompt via argv or stdin. The daemon creates the file before
  // buildArgs and removes it after the child exits.
  promptFilePath?: string;
  // Resume-capable adapters (resumesSessionViaCli) read these to decide
  // whether to continue the CLI's own session. `resumeSessionId` is the
  // stored id for this (conversation, agent) when a prior session exists;
  // the adapter passes it to the CLI's resume flag and the daemon sends
  // only the latest user turn. When it is null/absent the adapter starts
  // a new session using `newSessionId` (a freshly minted UUID the daemon
  // also persists) and the daemon seeds it with the full transcript.
  resumeSessionId?: string | null;
  newSessionId?: string;
};

export type RuntimeCapabilityMap = Record<string, boolean>;

export type RuntimeListModels = {
  args: string[];
  timeoutMs?: number;
  parse: (stdout: string) => RuntimeModelOption[] | null;
};

export type RuntimePromptBudgetError = {
  code: 'AGENT_PROMPT_TOO_LARGE';
  message: string;
  bytes?: number;
  commandLineLength?: number;
  limit: number;
};

export type RuntimeAgentDef = {
  id: string;
  name: string;
  bin: string;
  versionArgs: string[];
  fallbackModels: RuntimeModelOption[];
  buildArgs: (
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs?: string[],
    options?: RuntimeBuildOptions,
    runtimeContext?: RuntimeContext,
  ) => string[];
  streamFormat: string;
  fallbackBins?: string[];
  versionProbeTimeoutMs?: number;
  helpArgs?: string[];
  capabilityFlags?: Record<string, string>;
  // Adapter reads the composed prompt from a daemon-created temp file.
  // This is intentionally opt-in: stdin-capable adapters keep using
  // `promptViaStdin`, and argv-only adapters keep their argv budget guard
  // unless their CLI exposes an explicit prompt-file flag.
  promptViaFile?: boolean;
  promptViaStdin?: boolean;
  // Format for the user prompt fed via stdin. Default is plain text (the
  // entire prompt buffer goes in raw, then stdin is closed). When set to
  // 'stream-json' the daemon writes a single JSONL line wrapping the prompt
  // as an Anthropic user message (so tool_result blocks can later be
  // injected into the same stdin without re-spawning the child). Only
  // honored for adapters that also set `promptViaStdin: true`.
  promptInputFormat?: 'text' | 'stream-json';
  eventParser?: string;
  env?: Record<string, string>;
  listModels?: RuntimeListModels;
  fetchModels?: (
    resolvedBin: string,
    env: RuntimeEnv,
  ) => Promise<RuntimeModelOption[] | null>;
  reasoningOptions?: RuntimeReasoningOption[];
  supportsImagePaths?: boolean;
  maxPromptArgBytes?: number;
  // How the daemon forwards the user's `.od/mcp-config.json` external MCP
  // servers to this runtime at spawn time:
  //
  //   'claude-mcp-json' — write `.mcp.json` into the managed
  //                       project cwd (Claude Code auto-loads it).
  //
  // Leave undefined for adapters that have no native MCP transport
  // wired yet (copilot). The settings UI reads this field to surface an
  // explicit "external MCP is not forwarded to <agent>; configure servers
  // in <agent>'s own config file instead" hint, replacing the previous
  // silent-failure UX from issue #2142.
  externalMcpInjection?: 'claude-mcp-json';
  installUrl?: string;
  docsUrl?: string;
  // When `false`, the Settings model picker hides the "Custom (fill below)"
  // option and the associated free-text input. Use this for agents whose
  // CLI does not actually accept a model id. Defaults to allowing custom
  // input (undefined === true) so most adapters keep today's UX.
  supportsCustomModel?: boolean;
  // When `true`, the adapter's CLI can resume its own prior session:
  // the daemon mints `RuntimeContext.newSessionId` and the CLI is told
  // to use it (claude `--session-id`), so the id the daemon stores is
  // the id it generated ("specify-style" resume).
  resumesSessionViaCli?: boolean;
  // Agent-recommended override for the chat-run inactivity watchdog.
  // The watchdog observes child stdout/stderr/SSE activity, not real
  // CPU progress, so agents whose CLIs go silent for long stretches
  // during legitimate work (e.g. Copilot's long thinking phases from
  // #2467) need a longer ceiling than the 10-minute global default.
  // Operators can still override per-process via
  // `OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS` — that env wins.
  inactivityTimeoutMs?: number;
  // Declarative authentication probe. When set, detection spawns
  // `<bin> <args>` after the version check and classifies the combined
  // stdout/stderr to derive `authStatus`. An adapter opts in by declaring
  // a cheap, side-effect-free status/whoami command. Adapters WITHOUT
  // this field are never actively probed for auth — their auth status is
  // only inferred later from a real chat failure's error text (see
  // classifyAgentServiceFailure).
  authProbe?: {
    args: string[];
    timeoutMs?: number;
    // Agent id whose tailored auth classifier should be used for this
    // probe when it differs from the runtime agent id. Defaults to the
    // def id when unset.
    classifierAgentId?: string;
  };
};

export type DetectedAgent = Omit<
  RuntimeAgentDef,
  | 'buildArgs'
  | 'listModels'
  | 'fetchModels'
  | 'fallbackModels'
  | 'helpArgs'
  | 'capabilityFlags'
  | 'fallbackBins'
  | 'versionProbeTimeoutMs'
  | 'maxPromptArgBytes'
  | 'env'
  // `inactivityTimeoutMs` is a spawn-time-only hint consumed by the
  // chat-run watchdog. It is not part of the public `/api/agents`
  // contract (`packages/contracts/src/api/registry.ts#AgentInfo`), so
  // omitting it here keeps the daemon response aligned with that
  // shared web/CLI shape — agents pick it up by reading the runtime
  // def directly, the registry payload stays unchanged.
  | 'inactivityTimeoutMs'
  | 'authProbe'
> & {
  models: RuntimeModelOption[];
  modelsSource: RuntimeModelSource;
  available: boolean;
  authStatus?: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
  path?: string;
  version?: string | null;
  diagnostics?: AgentDiagnostic[];
};

export type RuntimeExecOptions = ExecFileOptions & {
  env?: NodeJS.ProcessEnv;
};
