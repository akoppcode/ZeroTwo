// Lean agent chat for the Zero Two report workspace. Talks to the project's
// agent (Claude Code / Copilot) with cwd = the PBIP folder so the agent edits
// the report in place. Reuses the daemon run client (`streamViaDaemon`) — the
// same POST /api/runs + SSE plumbing ProjectView's ChatPane uses — but keeps a
// local, in-memory transcript instead of the full conversation/persistence,
// plugin, skill, and design-system machinery.
//
// TODO(chat depth): persist turns to a conversation, restore history on
// re-open, and surface tool activity / thinking (currently only assistant text
// is rendered). See ChatPane for the full-fidelity surface.

import { useCallback, useEffect, useRef, useState } from 'react';
import { streamViaDaemon } from '../providers/daemon';
import type { ChatMessage } from '../types';
import { randomUUID } from '../utils/uuid';
import { Icon } from './Icon';

interface Props {
  projectId: string;
  /** 'claude' | 'copilot' — the agent the project was attached/scaffolded with. */
  agent: string;
  /** The PBIP folder the agent runs in (shown as a working-dir pill). */
  workingDir: string;
  /**
   * A prompt pushed from comment mode (annotation "Send to agent"). Each new
   * value is appended to the composer so the user can review/extend before send.
   */
  injectedPrompt?: string | null;
  /** Called once an injected prompt has been consumed into the composer. */
  onInjectedPromptConsumed?: () => void;
}

export function ZeroTwoChatPane({ projectId, agent, workingDir, injectedPrompt, onInjectedPromptConsumed }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Append an annotation-mode prompt into the composer for review before send.
  useEffect(() => {
    if (!injectedPrompt) return;
    setInput((prev) => (prev ? `${prev}\n\n${injectedPrompt}` : injectedPrompt));
    onInjectedPromptConsumed?.();
  }, [injectedPrompt, onInjectedPromptConsumed]);

  // Keep the latest turn in view as text streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(() => {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    setError(null);
    setInput('');

    const userMessage: ChatMessage = { id: randomUUID(), role: 'user', content: prompt };
    const assistantId = randomUUID();
    const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '' };
    // History sent to the agent is the transcript BEFORE this turn's empty
    // assistant placeholder; streamViaDaemon reads the trailing user prompt.
    const history = [...messages, userMessage];
    setMessages([...history, assistantMessage]);
    setStreaming(true);

    const appendAssistant = (delta: string) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
      );
    };

    const controller = new AbortController();
    abortRef.current = controller;

    void streamViaDaemon({
      agentId: agent,
      history,
      projectId,
      conversationId: null,
      signal: controller.signal,
      handlers: {
        onDelta: appendAssistant,
        onAgentEvent: () => {
          /* Text arrives via onDelta; richer events are deferred (see header TODO). */
        },
        onDone: () => {
          setStreaming(false);
          abortRef.current = null;
        },
        onError: (err) => {
          setError(err.message || 'The agent run failed.');
          setStreaming(false);
          abortRef.current = null;
        },
      },
    });
  }, [input, streaming, messages, agent, projectId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  return (
    <section className="zt-chat" aria-label="Agent chat" data-testid="zerotwo-chat">
      <header className="zt-chat__head">
        <p className="zt-projects__kicker">Agent</p>
        <span className="zt-chat__cwd" title={workingDir} data-testid="zerotwo-chat-cwd">
          <Icon name="folder" size={12} />
          <span className="zt-chat__cwd-path">{workingDir}</span>
        </span>
      </header>

      <div className="zt-chat__log" ref={scrollRef} data-testid="zerotwo-chat-log">
        {messages.length === 0 ? (
          <p className="zt-chat__empty" data-testid="zerotwo-chat-empty">
            Ask the agent to change your report — it edits the PBIP directly, then re-run the pipeline to preview.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`zt-chat__msg zt-chat__msg--${m.role}`} data-testid={`zerotwo-chat-msg-${m.role}`}>
              {m.content || (m.role === 'assistant' && streaming ? '…' : '')}
            </div>
          ))
        )}
      </div>

      {error ? (
        <div className="zt-notice zt-notice--error" role="alert" data-testid="zerotwo-chat-error">
          <Icon name="alert-triangle" size={14} />
          <p className="zt-notice__text">{error}</p>
        </div>
      ) : null}

      <form
        className="zt-chat__composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className="zt-chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message the agent…"
          rows={2}
          data-testid="zerotwo-chat-input"
        />
        {streaming ? (
          <button type="button" className="zt-btn" onClick={stop} data-testid="zerotwo-chat-stop">
            <Icon name="spinner" size={14} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="submit"
            className="zt-btn zt-btn--primary"
            disabled={!input.trim()}
            data-testid="zerotwo-chat-send"
          >
            <Icon name="send" size={14} />
            <span>Send</span>
          </button>
        )}
      </form>
    </section>
  );
}
