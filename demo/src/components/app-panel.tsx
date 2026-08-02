import type { ReactNode } from "react";
import { ArrowUp, Bot, RefreshCcw, UserRound } from "lucide-react";
import { Streamdown } from "streamdown";
import { EventActions, StartFormCard } from "@/components/event-actions";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageAvatar, MessageContent, MessageFooter } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { TraceEntry } from "@/lib/agent-runner";
import type { ChatIdle, JsonObject } from "@/lib/machine-ui";
import { stateValueLabel, traceSteps, type TraceStep } from "@/lib/trace-view";

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
  /** For "action" turns: the event type echoed beside the chip, when known. */
  eventType?: string;
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
  /** Accepted and ignored: the panel no longer renders a heading. */
  title?: string;
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

/** The state that produced this answer: the last committed transition target. */
function resultState(result: ChatTurnResult): string {
  const committed = result.trace.filter(
    (entry) => entry.event.type !== "xstate.init" && entry.event.type !== "@xstate.init",
  );
  const last = committed[committed.length - 1];
  return last ? stateValueLabel(last.value) : result.mode;
}

/** A committed transition, as a compact log line: `EVENT → target`. */
function TraceStepRow({ step }: { step: TraceStep }) {
  const eventType = step.title.replace(/\s[✓✗]$/, "");
  const target = step.detail.replace(/^→\s*/, "");
  return (
    <div className="chat-trace__row" data-kind={step.kind}>
      <span className="chat-trace__event">{eventType}</span>
      <span className="chat-trace__arrow" aria-hidden="true">
        →
      </span>
      <span className="chat-trace__target">{target}</span>
    </div>
  );
}

/** Left-aligned "the machine is waiting for you" affordance. */
function WaitingIndicator({ idle }: { idle: ChatIdle }) {
  return (
    <div className="chat-waiting" role="status">
      <div className="chat-waiting__row">
        <span className="chat-waiting__dot" aria-hidden="true" />
        <span className="chat-waiting__label">machine is waiting for you</span>
        {idle.component ? <span className="chat-waiting__state">{idle.component}</span> : null}
      </div>
      {idle.prompt ? <p className="chat-waiting__prompt">{idle.prompt}</p> : null}
    </div>
  );
}

/**
 * The unified chat panel: message list plus composer. Works for any machine —
 * free text starts a run or maps to the idle state's text event, accepted
 * events render as buttons in the composer (with schema-generated payload
 * forms and optional custom renderers), and out-of-place messages stay in the
 * log marked ignored.
 */
export function AppPanel({
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
  const textDisabled = loading || !textPolicy.visible;

  return (
    <section className="work-panel app-panel" aria-label="Running app">
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
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
                  <div className="chat-turn">
                    {turn.role === "action" ? (
                      <div className="chat-echo">
                        <span className="chat-echo__chip">{turn.input}</span>
                        {turn.eventType ? (
                          <span className="chat-echo__type">{turn.eventType}</span>
                        ) : null}
                      </div>
                    ) : (
                      <Message align="end">
                        <MessageAvatar className="chat-avatar">
                          <UserRound size={15} aria-hidden="true" />
                        </MessageAvatar>
                        <MessageContent>
                          <Bubble align="end">
                            <BubbleContent>{turn.input}</BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    )}

                    {turn.status === "loading" ? (
                      <p className="chat-system" role="status">
                        running the machine…
                      </p>
                    ) : null}

                    {turn.status === "ignored" ? (
                      <p className="chat-system" role="status">
                        not an accepted event in the current state — the machine ignored it
                      </p>
                    ) : null}

                    {turn.status === "ready" && turn.result ? (
                      <>
                        {traceSteps(turn.result.trace).length ? (
                          <div className="chat-trace" aria-label="Machine transitions">
                            {traceSteps(turn.result.trace).map((step, index) => (
                              <TraceStepRow key={index} step={step} />
                            ))}
                          </div>
                        ) : null}
                        <Message>
                          <MessageAvatar className="chat-avatar">
                            <Bot size={15} aria-hidden="true" />
                          </MessageAvatar>
                          <MessageContent>
                            <Bubble variant="muted">
                              <BubbleContent>
                                <Streamdown className="assistant-markdown">
                                  {turn.result.response}
                                </Streamdown>
                              </BubbleContent>
                            </Bubble>
                            <MessageFooter className="chat-state-tag">
                              {resultState(turn.result)}
                            </MessageFooter>
                          </MessageContent>
                        </Message>
                        {turn.result.status === "done" ? (
                          <p className="chat-system">machine reached final state</p>
                        ) : null}
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
                <MessageScrollerItem messageId="waiting">
                  <WaitingIndicator idle={pendingIdle} />
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="chat-composer">
        {pendingIdle && !loading ? (
          <EventActions idle={pendingIdle} onSendEvent={onSendEvent} />
        ) : null}

        {finished ? (
          <div className="chat-composer__footer">
            <button className="chat-restart" onClick={onRestart}>
              <RefreshCcw size={14} aria-hidden="true" />
              Run again
            </button>
          </div>
        ) : (
          <form
            className="chat-input"
            data-disabled={textDisabled || undefined}
            onSubmit={(event) => {
              event.preventDefault();
              if (textDisabled) return;
              onSubmit(input);
            }}
          >
            <textarea
              className="chat-input__textarea"
              name="message"
              rows={2}
              value={textDisabled ? "" : input}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder={
                loading
                  ? "Agent is working…"
                  : textPolicy.visible
                    ? textPolicy.placeholder
                    : "The machine isn't accepting free text right now — use the controls above"
              }
              maxLength={2000}
              disabled={textDisabled}
              aria-label="Message"
            />
            <button
              className="chat-send"
              type="submit"
              aria-label={textPolicy.submitLabel || "Send"}
              disabled={textDisabled || !input.trim()}
            >
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          </form>
        )}

        {textPolicy.note ? <p className="chat-composer__note">{textPolicy.note}</p> : null}
      </div>
    </section>
  );
}
