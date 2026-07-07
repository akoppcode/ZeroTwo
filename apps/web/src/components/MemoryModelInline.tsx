// Inline "Memory model" picker — sits right next to the chat model
// dropdown inside Settings → Execution mode.
//
// Why one tiny dropdown instead of a separate panel:
// User feedback was explicit — the memory extractor isn't a parallel
// feature, it's "the same CLI as chat, with a different (and usually
// cheaper) model". So the picker is a single field whose default path
// follows the selected CLI itself.
//
// Three render branches:
//   - "Same as chat" (default): clears the override on the daemon —
//     auto-pick chooses a fast default.
//   - A suggested model: stores { provider, model, ... } derived from
//     the selected agent/model as metadata; the daemon can still run
//     the supported local CLI runner for "same as chat".
//   - "Custom..." sentinel: opens a free-text input. Same persistence
//     as the suggested branch.
//
// Persistence: PATCH /api/memory/config. The daemon stores the chosen
// override under <dataDir>/memory/.config.json and reads it on every
// extraction attempt — a single PATCH propagates without a daemon
// restart.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { useT } from '../i18n';
import type {
  MemoryExtractionConfig as MemoryExtractionConfigShape,
  MemoryExtractionMaskedConfig,
  MemoryExtractionProvider,
  MemoryListResponse,
} from '@open-design/contracts';
import type { AgentModelOption } from '../types';
import {
  CUSTOM_MODEL_SENTINEL,
  SearchableModelSelect,
} from './modelOptions';

interface Props {
  // The chat model is shown next to the "Same as chat" pill so the
  // user can see what the auto-default picks today.
  chatModel: string;
  // Used to seed the dropdown options with the same model list the
  // chat picker shows for the selected agent.
  cliModelOptions?: readonly string[];
  // The currently-selected CLI agent id. Used to derive a chat
  // protocol family (claude → anthropic, copilot → openai) so the
  // dropdown's "Same as chat" label can show the actual provider the
  // daemon will call, and so the user sees a clear "needs an X API
  // key" hint instead of being surprised when extraction silently
  // lands on another vendor.
  cliAgentId?: string | null;
}

// "No override" sentinel — distinct from CUSTOM_MODEL_SENTINEL so the
// reducer can switch between "clear override" and "let me type" cleanly.
const SAME_AS_CHAT_SENTINEL = '__same_as_chat__';

// Pattern-match a model id back to a provider/protocol. The CLI has
// no surrounding API protocol to lean on, so we read the prefix the
// same way the chat picker would: claude-* → Anthropic API, gemini-*
// → Google Gemini, everything else → OpenAI-compatible.
function inferProviderFromModel(modelId: string): MemoryExtractionProvider {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith('claude') || id.includes('/claude')) return 'anthropic';
  if (id.startsWith('gemini') || id.includes('/gemini')) return 'google';
  return 'openai';
}

// Map a CLI agent id to the API protocol family it speaks. Mirrors the
// daemon-side `chatProtocolFromAgentId()` in `memory-llm.ts` exactly —
// keep the two tables in sync so the UI's "Same as chat" label and the
// daemon's auto-pick agree on which provider memory will actually call.
function chatProtocolFromAgent(
  agentId: string | null | undefined,
): MemoryExtractionProvider | null {
  if (!agentId) return null;
  const id = agentId.trim().toLowerCase();
  if (id === 'claude') return 'anthropic';
  if (id === 'copilot') return 'openai';
  return null;
}

function cliAgentLabel(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  const id = agentId.trim().toLowerCase();
  const labels: Record<string, string> = {
    claude: 'Claude Code',
    copilot: 'GitHub Copilot CLI',
  };
  return labels[id] ?? agentId;
}

async function fetchMemoryExtraction(): Promise<MemoryExtractionMaskedConfig | null> {
  try {
    const resp = await fetch('/api/memory');
    if (!resp.ok) return null;
    const json = (await resp.json()) as MemoryListResponse;
    return json.extraction ?? null;
  } catch {
    return null;
  }
}

async function saveMemoryExtraction(
  extraction: MemoryExtractionConfigShape | null,
): Promise<MemoryExtractionMaskedConfig | null | undefined> {
  const resp = await fetch('/api/memory/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extraction }),
  });
  if (!resp.ok) return undefined;
  const json = (await resp.json()) as {
    enabled: boolean;
    extraction: MemoryExtractionMaskedConfig | null;
  };
  return json.extraction ?? null;
}

export function MemoryModelInline({
  chatModel,
  cliModelOptions,
  cliAgentId,
}: Props) {
  const t = useT();
  const [config, setConfig] = useState<MemoryExtractionMaskedConfig | null>(
    null,
  );
  const [customEditing, setCustomEditing] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Brief inline confirmation after Save / clear so the user knows
  // their click did something even though the dropdown just settles.
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMemoryExtraction().then((next) => {
      if (cancelled) return;
      setConfig(next);
      if (next?.model) setCustomDraft(next.model);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(id);
  }, [flash]);

  // The protocol family used for metadata and explicit model overrides,
  // derived from the agent id (claude → anthropic, copilot → openai),
  // while the "Same as chat" default can still run the selected local
  // CLI directly on daemon-supported adapters.
  const effectiveChatProtocol: MemoryExtractionProvider | null =
    chatProtocolFromAgent(cliAgentId);
  const sameAsChatCliLabel = cliAgentLabel(cliAgentId);

  // The {id,label} option list fed to the searchable dropdown — the
  // agent's advertised models.
  const pickerModels = useMemo<AgentModelOption[]>(
    () => (cliModelOptions ?? []).map((id) => ({ id, label: id })),
    [cliModelOptions],
  );

  // Plain id list — drives the "is the saved model a known option vs a custom
  // id" decision below.
  const modelOptions = useMemo<readonly string[]>(
    () => pickerModels.map((m) => m.id),
    [pickerModels],
  );

  const savedModel = config?.model ?? '';
  const savedInOptions =
    Boolean(savedModel) && modelOptions.includes(savedModel);
  const customActive = customEditing || (Boolean(savedModel) && !savedInOptions);
  const selectValue = !savedModel
    ? SAME_AS_CHAT_SENTINEL
    : customActive
      ? CUSTOM_MODEL_SENTINEL
      : savedModel;

  // Build the override payload to PATCH for a given model id. There's
  // no browser-side chat key to borrow: we derive a provider for
  // metadata and for unsupported CLI adapters, while the daemon can
  // run supported Local CLIs directly when the picker is on "Same as
  // chat".
  const buildOverride = useCallback(
    (modelId: string): MemoryExtractionConfigShape => {
      const trimmedModel = modelId.trim();
      const provider =
        chatProtocolFromAgent(cliAgentId)
        ?? inferProviderFromModel(trimmedModel);
      return {
        provider,
        model: trimmedModel,
        baseUrl: '',
        apiKey: '',
        apiVersion: '',
      };
    },
    [cliAgentId],
  );

  const persist = useCallback(
    async (
      next: MemoryExtractionConfigShape | null,
      options?: { silent?: boolean },
    ) => {
      setBusy(true);
      try {
        const result = await saveMemoryExtraction(next);
        if (result !== undefined) {
          setConfig(result);
          // Skip the "Saved!" flash on background re-syncs (provider
          // tab swap, base-URL keystroke autosave, key rotation). The
          // user didn't click anything here; flashing every keystroke
          // would feel like the picker is "fighting" them.
          if (!options?.silent) {
            setFlash(
              next === null
                ? t('settings.memoryModelInlineFlashCleared')
                : t('settings.memoryModelInlineFlashSaved'),
            );
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const onSelectChange = useCallback(
    async (value: string) => {
      if (value === SAME_AS_CHAT_SENTINEL) {
        setCustomEditing(false);
        setCustomDraft('');
        await persist(null);
        return;
      }
      if (value === CUSTOM_MODEL_SENTINEL) {
        // Just open the input — don't PATCH yet. The user can type a
        // model id and press the Save button below; clicking the
        // dropdown again before saving collapses the input and reverts
        // to the previous saved value.
        setCustomEditing(true);
        setCustomDraft(savedModel || '');
        return;
      }
      setCustomEditing(false);
      await persist(buildOverride(value));
    },
    [persist, buildOverride, savedModel],
  );

  const onSaveCustom = useCallback(async () => {
    const trimmed = customDraft.trim();
    if (!trimmed) return;
    await persist(buildOverride(trimmed));
    setCustomEditing(false);
  }, [customDraft, persist, buildOverride]);

  // Stable unique id for the labelling span so multiple instances of
  // this picker (or instances rendered alongside other Memory pickers)
  // never collide on a global selector. The select uses
  // `aria-labelledby` to point at *just* the short title — never the
  // hint paragraph, never the flash status — so Playwright's
  // `getByLabel('Memory model')` resolves to a single combobox and
  // `getByLabel('API key' / 'Model')` on the surrounding chat form
  // can't accidentally cross-match the hint copy here.
  const labelId = useId();
  const sameAsChatLabel = sameAsChatCliLabel
    ? t('settings.memoryModelInlineSameAsChatWithModel', {
        model: sameAsChatCliLabel,
      })
    : effectiveChatProtocol
      ? t('settings.memoryModelInlineSameAsChatWithProvider', {
          provider: effectiveChatProtocol,
        })
      : chatModel
        ? t('settings.memoryModelInlineSameAsChatWithModel', {
            model: chatModel,
          })
        : t('settings.memoryModelInlineSameAsChat');
  const selectOptions = useMemo(
    () => [
      { id: SAME_AS_CHAT_SENTINEL, label: sameAsChatLabel },
      ...modelOptions.map((model) => ({ id: model, label: model })),
      { id: CUSTOM_MODEL_SENTINEL, label: t('settings.modelCustom') },
    ],
    [modelOptions, sameAsChatLabel, t],
  );

  // The wrapper used to be a <label>, which made the select's
  // accessible name absorb every text descendant (the flash status,
  // the hint paragraph). The reviewer asked for a non-label wrapper so
  // the labelling element is just the short title; we now use a div
  // with an explicit id-based association via `aria-labelledby`.
  return (
    <div className="field">
      <span id={labelId} className="field-label">
        {t('settings.memoryModelInlineLabel')}
      </span>
      {flash ? (
        <span
          role="status"
          aria-live="polite"
          style={{
            display: 'inline-block',
            marginLeft: 8,
            marginTop: -2,
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--text-success, #1f7a3a)',
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          {flash}
        </span>
      ) : null}
      <SearchableModelSelect
        aria-labelledby={labelId}
        className="inline-switcher__select settings-model-select settings-model-select--byok"
        searchPlaceholder={t('designs.searchPlaceholder')}
        searchInputTestId="memory-model-inline-search"
        popoverTestId="memory-model-inline-popover"
        popoverClassName="settings-byok-select-popover"
        models={selectOptions}
        value={selectValue}
        disabled={busy}
        onChange={(value) => void onSelectChange(value)}
      />
      {customActive ? (
        <div
          className="field-row"
          style={{ marginTop: 6, display: 'flex', gap: 6 }}
        >
          <input
            type="text"
            aria-label={t('settings.memoryModelInlineLabel')}
            value={customDraft}
            placeholder={t('settings.modelCustomPlaceholder')}
            onChange={(e) => setCustomDraft(e.target.value.trimStart())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void onSaveCustom();
              }
            }}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => void onSaveCustom()}
            disabled={busy || !customDraft.trim()}
          >
            {t('common.save')}
          </button>
        </div>
      ) : null}
      <p className="hint" style={{ marginTop: 4, fontSize: 11 }}>
        {effectiveChatProtocol
          ? t('settings.memoryModelInlineHintCliConstrained', {
              provider: effectiveChatProtocol,
            })
          : t('settings.memoryModelInlineHintCli')}
      </p>
    </div>
  );
}
