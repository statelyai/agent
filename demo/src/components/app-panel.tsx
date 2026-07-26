import type { ReactNode } from "react";
import { ArrowRight, Bot, Check, CircleAlert, LoaderCircle, RefreshCcw, UserRound } from "lucide-react";
import { Streamdown } from "streamdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { EventActions, StartFormCard } from "@/components/event-actions";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { TraceEntry } from "@/lib/agent-runner";
import type { ChatIdle, JsonObject } from "@/lib/machine-ui";
import { traceSteps, type TraceStep } from "@/lib/trace-view";

/** The common shape of a settled run, scenario or library example alike. */
export type ChatTurnResult = {
  mode: string;
  model?: string;
  status: "done" | "idle" | "error";
  trace: TraceEntry[];
  response: string;
};

export type Turn = {
  id: number;
  input: string;
  role: "user" | "action";
  /** "ignored": free text the machine's current state doesn't consume. */
  status: "loading" | "ready" | "error" | "ignored";
  result?: ChatTurnResult;
  error?: string;
};

export type TextPolicy = {
  /** Text entry hidden entirely when false (note explains why). */
  visible: boolean;
  placeholder: string;
  submitLabel: string;
  /** Shown under the composer (e.g. "needs OPENAI_API_KEY"). */
  note?: string;
};

type AppPanelProps = {
  title: string;
  /** Empty-state content shown before the first turn. */
  intro: ReactNode;
  turns: Turn[];
  pendingIdle: ChatIdle | null;
  /** Structured-input start card (machines whose input isn't a single prompt). */
  startForm: { schema: JsonObject; onStart: (values: Record<string, unknown>) => void } | null;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onSendEvent: (event: { type: string; [key: string]: unknown }) => void;
  onRestart: () => void;
  textPolicy: TextPolicy;
};

/** The event token: `EVENT_TYPE  →  targetState · payload`, styled like a trace-log line. */
function TraceStepRow({ step }: { step: TraceStep }) {
  const eventType = step.title.replace(/\s[✓✗]$/, "");
  const target = step.detail.replace(/^→\s*/, "");
  const isError = step.kind === "error";
  return (
    <div className="trace-step" data-kind={step.kind}>
      <span className="trace-step__dot" aria-hidden="true" />
      <code className="trace-step__event">{eventType}</code>
      <ArrowRight className="trace-step__arrow" size={13} aria-hidden="true" />
      <code className="trace-step__target">{target}</code>
      {isError ? (
        <CircleAlert className="trace-step__status trace-step__status--error" size={14} aria-label="Error" />
      ) : (
        <Check className="trace-step__status trace-step__status--ok" size={14} aria-label="Transition committed" />
      )}
    </div>
  );
}

function PendingRow() {
  return (
    <div className="trace-step trace-step--pending" role="status">
      <span className="trace-step__dot" aria-hidden="true" />
      <code className="trace-step__event">runAgent</code>
      <span className="trace-step__running">running the machine…</span>
      <LoaderCircle className="trace-step__status trace-step__spinner" size={14} aria-label="Running" />
    </div>
  );
}

function RunMode({ result }: { result: ChatTurnResult }) {
  const script = result.mode === "script";
  return (
    <span className="run-mode" data-script={script || undefined}>
      <span className="run-mode__tag">{script ? "Script · keyless" : `Live · ${result.model}`}</span>
      <span className="run-mode__note">
        {script ? "same machine, injected executors, no API calls" : "model-driven run"}
      </span>
    </span>
  );
}

function UserMessage({ text, role }: { text: string; role: Turn["role"] }) {
  return (
    <Message align="end">
      <MessageAvatar className="message-avatar" aria-hidden="true">
        {role === "action" ? <Check size={14} /> : <UserRound size={15} />}
      </MessageAvatar>
      <MessageContent>
        <Bubble align="end">
          <BubbleContent>{text}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function AssistantMessage({ result }: { result: ChatTurnResult }) {
  return (
    <Message>
      <MessageAvatar className="message-avatar" aria-hidden="true">
        <Bot size={15} />
      </MessageAvatar>
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <Streamdown className="assistant-markdown">{result.response}</Streamdown>
          </BubbleContent>
        </Bubble>
        <RunMode result={result} />
      </MessageContent>
    </Message>
  );
}

/**
 * The unified chat panel. Works for any machine: free text starts a run or
 * maps to the idle state's text event; accepted events render as buttons via
 * `EventActions` (with schema-generated payload dialogs); out-of-place
 * messages are kept in the log but marked ignored.
 */
export function AppPanel({
  title,
  intro,
  turns,
  pendingIdle,
  startForm,
  input,
  onInputChange,
  onSubmit,
  onSendEvent,
  onRestart,
  textPolicy,
}: AppPanelProps) {
  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const lastReady = [...turns].reverse().find((turn) => turn.status === "ready")?.result;
  const finished = !pendingIdle && !loading && started && lastReady && lastReady.status !== "idle";

  const status: "ready" | "running" | "awaiting" | "done" = pendingIdle
    ? "awaiting"
    : loading
      ? "running"
      : finished
        ? "done"
        : "ready";
  const stateLabel = pendingIdle
    ? "idle · awaiting input"
    : loading
      ? "running"
      : lastReady
        ? lastReady.status
        : "ready";

  return (
    <section className="work-panel app-panel" aria-labelledby="app-panel-title">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Running app</span>
          <h2 id="app-panel-title">{title}</h2>
        </div>
        <span className="state-pill" data-status={status}>
          <span className="state-pill__dot" aria-hidden="true" />
          {stateLabel}
        </span>
      </div>

      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport aria-label="Agent conversation">
            <MessageScrollerContent className="chat-content" aria-live="polite">
              {!started ? <MessageScrollerItem messageId="intro">{intro}</MessageScrollerItem> : null}

              {!started && startForm ? (
                <MessageScrollerItem messageId="start-form">
                  <StartFormCard schema={startForm.schema} onStart={startForm.onStart} />
                </MessageScrollerItem>
              ) : null}

              {turns.map((turn) => (
                <MessageScrollerItem key={turn.id} messageId={`turn-${turn.id}`} scrollAnchor>
                  <div className="conversation-turn">
                    <UserMessage text={turn.input} role={turn.role} />
                    {turn.status === "loading" ? <PendingRow /> : null}
                    {turn.status === "ignored" ? (
                      <p className="ignored-note" role="status">
                        Not an accepted event in the current state — the machine ignored it.
                      </p>
                    ) : null}
                    {turn.status === "ready" && turn.result ? (
                      <>
                        {traceSteps(turn.result.trace).length ? (
                          <div className="trace-log" aria-label="Machine transitions">
                            {traceSteps(turn.result.trace).map((step, index) => (
                              <TraceStepRow key={index} step={step} />
                            ))}
                          </div>
                        ) : null}
                        <AssistantMessage result={turn.result} />
                      </>
                    ) : null}
                    {turn.status === "error" ? (
                      <Bubble variant="destructive">
                        <BubbleContent>{turn.error}</BubbleContent>
                      </Bubble>
                    ) : null}
                  </div>
                </MessageScrollerItem>
              ))}

              {pendingIdle && !loading ? (
                <MessageScrollerItem messageId="event-actions">
                  <EventActions idle={pendingIdle} onSendEvent={onSendEvent} />
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      {finished ? (
        <div className="run-again">
          <Button variant="ghost" size="sm" onClick={onRestart}>
            <RefreshCcw size={15} />
            Run again
          </Button>
        </div>
      ) : textPolicy.visible ? (
        <form
          className="prompt-input"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(input);
          }}
        >
          <textarea
            className="prompt-input__textarea"
            name="message"
            rows={2}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder={textPolicy.placeholder}
            maxLength={2000}
            disabled={loading}
            aria-label="Message"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!input.trim() || loading}>
            {loading ? "Running…" : textPolicy.submitLabel}
          </Button>
        </form>
      ) : null}
      {textPolicy.note ? <p className="composer-note">{textPolicy.note}</p> : null}
    </section>
  );
}
