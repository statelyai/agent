import { ArrowRight, Bot, Check, CircleAlert, Eye, LoaderCircle, RefreshCcw, UserRound } from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { ScenarioResult } from "@/lib/agent-runner";
import type { Scenario, ScenarioId } from "@/lib/scenarios";
import { traceSteps, type TraceStep } from "@/lib/trace-view";

export type Turn = {
  id: number;
  input: string;
  role: "user" | "action";
  status: "loading" | "ready" | "error";
  result?: ScenarioResult;
  error?: string;
};

export type PendingIdle = {
  scenarioId: Scenario["id"];
  acceptedEvents: string[];
  prompt?: string;
};

type AppPanelProps = {
  scenario: Scenario;
  turns: Turn[];
  pendingIdle: PendingIdle | null;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onResume: (event: { type: string; [key: string]: unknown }) => void;
  onRestart: () => void;
};

/** Presentational "what to watch for" hints per scenario, keyed off the id. */
const watchHints: Record<ScenarioId, string> = {
  refund: "The amount is over $100, so the machine routes to human approval — the model never gets to auto-refund.",
  approval: "The run pauses in an idle state. Nothing publishes until you approve — that's the human in the loop.",
  routing: "The model returns one typed event; watch the statechart jump to exactly one branch.",
  research: "Two regions light up at once, then converge — the machine waits for both before synthesizing.",
  pipeline: "Three states run in order. Each has its own output and its own failure boundary.",
  retry: "Watch the retry counter and the switch to the fallback model when the primary call fails.",
  tools: "The loop is capped by the machine — after the budget, it's forced to answer instead of calling more tools.",
  reflection: "Draft → score → revise repeats until the score clears the bar or the budget runs out.",
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

function RunMode({ result }: { result: ScenarioResult }) {
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

function AssistantMessage({ result }: { result: ScenarioResult }) {
  return (
    <Message>
      <MessageAvatar className="message-avatar" aria-hidden="true">
        <Bot size={15} />
      </MessageAvatar>
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>{result.response}</BubbleContent>
        </Bubble>
        <RunMode result={result} />
      </MessageContent>
    </Message>
  );
}

function ApprovalCard({ pending, onResume }: { pending: PendingIdle; onResume: AppPanelProps["onResume"] }) {
  const events = new Set(pending.acceptedEvents);
  const isRefund = events.has("DENY");
  return (
    <div className="approval-card" role="group" aria-label="Human decision required">
      <div className="approval-card__ribbon">
        <UserRound size={13} aria-hidden="true" />
        Human decision required
      </div>
      <div className="approval-card__body">
        <strong className="approval-card__title">
          {isRefund ? "Approve this refund?" : "Review before publishing"}
        </strong>
        <p>{pending.prompt ?? "This state is waiting for a human decision before the machine can continue."}</p>
        <div className="approval-card__actions">
          {events.has("APPROVE") ? (
            <Button variant="primary" size="sm" onClick={() => onResume({ type: "APPROVE" })}>
              <Check size={14} />
              {isRefund ? "Approve refund" : "Approve & publish"}
            </Button>
          ) : null}
          {events.has("DENY") ? (
            <Button size="sm" onClick={() => onResume({ type: "DENY" })}>
              Deny
            </Button>
          ) : null}
          {events.has("REJECT") ? (
            <Button size="sm" onClick={() => onResume({ type: "REJECT", reason: "Please revise the draft." })}>
              Request changes
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AppPanel({
  scenario,
  turns,
  pendingIdle,
  input,
  onInputChange,
  onSubmit,
  onResume,
  onRestart,
}: AppPanelProps) {
  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const lastReady = [...turns].reverse().find((turn) => turn.status === "ready")?.result;
  // Approval scenario stays open for free-text interpretation while idle.
  const interpretMode = pendingIdle?.scenarioId === "approval";
  const canEnterText = (!started || interpretMode) && !loading;
  const finished = !pendingIdle && !loading && started && lastReady?.status !== "idle";

  const status: "ready" | "running" | "awaiting" | "done" = pendingIdle
    ? "awaiting"
    : loading
      ? "running"
      : finished
        ? "done"
        : "ready";
  const stateLabel = pendingIdle
    ? "idle · awaiting human"
    : loading
      ? "running"
      : lastReady
        ? lastReady.status
        : "ready";

  const placeholder = interpretMode
    ? "Say “looks good” or “that’s no good”…"
    : scenario.placeholder;
  const submitLabel = interpretMode ? "Interpret review" : scenario.startLabel;

  return (
    <section className="work-panel app-panel" aria-labelledby="app-panel-title">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Running app</span>
          <h2 id="app-panel-title">{scenario.name}</h2>
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
              {!started ? (
                <MessageScrollerItem messageId="intro">
                  <div className="empty-state">
                    <div className="empty-state__badge" aria-hidden="true">
                      <Bot size={18} />
                    </div>
                    <span className="empty-state__eyebrow">{scenario.eyebrow}</span>
                    <p className="empty-state__lead">{scenario.description}</p>
                    <div className="empty-state__watch">
                      <span className="empty-state__watch-label">
                        <Eye size={13} aria-hidden="true" />
                        Watch for
                      </span>
                      <p>{watchHints[scenario.id]}</p>
                    </div>
                  </div>
                </MessageScrollerItem>
              ) : null}

              {turns.map((turn) => (
                <MessageScrollerItem key={turn.id} messageId={`turn-${turn.id}`} scrollAnchor>
                  <div className="conversation-turn">
                    <UserMessage text={turn.input} role={turn.role} />
                    {turn.status === "loading" ? <PendingRow /> : null}
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

              {pendingIdle ? (
                <MessageScrollerItem messageId="approval">
                  <ApprovalCard pending={pendingIdle} onResume={onResume} />
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
      ) : canEnterText ? (
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
            placeholder={placeholder}
            maxLength={2000}
            disabled={loading}
            aria-label="Message"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!input.trim() || loading}>
            {loading ? "Running…" : submitLabel}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
