import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { RefreshCcw } from "lucide-react";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/thread";
import { TransitionChip, TransitionStrip } from "@/components/transition-strip";
import { EventActions, StartFormCard } from "@/components/event-actions";
import { Button } from "@/components/ui/button";
import type { StarterAction } from "@/components/chat-intros";
import type { TraceEntry } from "@/lib/agent-runner";
import type { ChatIdle, JsonObject } from "@/lib/machine-ui";
import { stateValueLabel, traceSteps, type TraceStep } from "@/lib/trace-view";

export type ChatTurnResult = {
  model?: string;
  status: "done" | "idle" | "error";
  trace: TraceEntry[];
  response: string;
};

export type Turn = {
  id: number;
  input: string;
  role: "user" | "action";
  eventType?: string;
  status: "loading" | "ready" | "error" | "ignored" | "cancelled";
  result?: ChatTurnResult;
  error?: string;
  /** What a cancelled run showed before the stop: its live transitions and streamed text. */
  partial?: TurnPartial;
};

/** One streaming request's text so far, while its turn is in flight. */
export type LiveText = { key: string; call: number; label: string; text: string };

/** The live feed of a turn that did not settle, kept so a Cancel does not erase it. */
export type TurnPartial = { steps: TraceStep[]; text: LiveText[] };

export type TextPolicy = {
  visible: boolean;
  placeholder: string;
  submitLabel: string;
  note?: string;
};

type AppPanelProps = {
  title?: string;
  intro: ReactNode;
  starters: StarterAction[];
  turns: Turn[];
  /** Transitions streamed from live inspection while the last turn runs. */
  liveSteps: TraceStep[];
  /** Streamed model text of the turn in flight. */
  liveText: LiveText[];
  pendingIdle: ChatIdle | null;
  startForm: { schema: JsonObject; onStart: (values: Record<string, unknown>) => void } | null;
  onSubmit: (value: string) => void;
  onSendEvent: (event: { type: string; [key: string]: unknown }) => void;
  /** Aborts the in-flight run (composer stop button). */
  onCancel: () => void;
  onRestart: () => void;
  /** Idle waits this run has settled at — the time-travel rail. */
  textPolicy: TextPolicy;
};

function resultState(result: ChatTurnResult): string {
  const committed = result.trace.filter(
    (entry) => entry.event.type !== "xstate.init" && entry.event.type !== "@xstate.init",
  );
  const last = committed[committed.length - 1];
  return last ? stateValueLabel(last.value) : result.status;
}

/** TraceSteps → fake tool-call parts the TransitionChip renderer understands. */
function transitionPartsFor(turnId: number, steps: TraceStep[], idPrefix: string) {
  return steps.map((step, index) => ({
    type: "tool-call" as const,
    toolCallId: `turn-${turnId}-${idPrefix}-${index}`,
    toolName: step.label,
    args: {
      state: step.state,
      payload: step.payload,
      kind: step.kind,
      detail: step.detail,
      gap: index === 0 ? 0 : step.at - steps[index - 1].at,
    },
    result: step.state,
  }));
}

/** Live text parts: one lane alone reads as the reply; parallel lanes are labeled. */
function liveTextParts(lanes: LiveText[]) {
  return lanes.map((lane) => ({
    type: "text" as const,
    text: lanes.length === 1 ? lane.text : `**${lane.label}**\n\n${lane.text}`,
  }));
}

export function messagesFromTurns(
  turns: Turn[],
  liveSteps: TraceStep[],
  liveText: LiveText[],
): ThreadMessageLike[] {
  return turns.flatMap((turn, index): ThreadMessageLike[] => {
    const isLast = index === turns.length - 1;
    const userMessage: ThreadMessageLike = {
      id: `turn-${turn.id}-user`,
      role: "user",
      // The transition log below already names the event (`APPROVE → approved`),
      // so the bubble carries only the human-readable action label.
      content: [{ type: "text", text: turn.input }],
    };

    if (turn.status === "loading") {
      // Live inspection fills the transition log in, and streaming requests
      // their text, as the run happens; the server's result replaces both at
      // settle.
      if (!isLast || (liveSteps.length === 0 && liveText.length === 0)) return [userMessage];
      return [
        userMessage,
        {
          id: `turn-${turn.id}-assistant`,
          role: "assistant",
          content: [...transitionPartsFor(turn.id, liveSteps, "live"), ...liveTextParts(liveText)],
          status: { type: "running" },
        },
      ];
    }

    if (turn.status === "ignored") {
      return [
        userMessage,
        {
          id: `turn-${turn.id}-assistant`,
          role: "assistant",
          content: "That message isn’t an accepted event in the machine’s current state.",
          status: { type: "complete", reason: "stop" },
        },
      ];
    }

    if (turn.status === "cancelled") {
      // The work gathered before the stop stays: the transitions it made and
      // what it streamed, then the note.
      const partial = turn.partial ?? { steps: [], text: [] };
      return [
        userMessage,
        {
          id: `turn-${turn.id}-assistant`,
          role: "assistant",
          content: [
            ...transitionPartsFor(turn.id, partial.steps, "cancelled"),
            ...liveTextParts(partial.text),
            { type: "text", text: "Run cancelled." },
          ],
          status: { type: "incomplete", reason: "cancelled" },
        },
      ];
    }

    if (turn.status === "error") {
      // The error banner carries the message; repeating it as the body
      // would show it twice.
      return [
        userMessage,
        {
          id: `turn-${turn.id}-assistant`,
          role: "assistant",
          content: [],
          status: {
            type: "incomplete",
            reason: "error",
            error: turn.error ?? "Agent request failed",
          },
        },
      ];
    }

    if (!turn.result) return [userMessage];

    const transitionParts = transitionPartsFor(
      turn.id,
      traceSteps(turn.result.trace),
      "transition",
    );
    // An idle turn with nothing new to say leaves the words to the waiting box.
    const response =
      turn.result.response ||
      (turn.result.status === "done"
        ? "The machine reached its final state."
        : turn.result.status === "idle"
          ? ""
          : "Ready.");
    const textParts = response ? [{ type: "text" as const, text: response }] : [];
    if (transitionParts.length === 0 && textParts.length === 0) return [userMessage];

    return [
      userMessage,
      {
        id: `turn-${turn.id}-assistant`,
        role: "assistant",
        content: [...transitionParts, ...textParts],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: { state: resultState(turn.result) } },
      },
    ];
  });
}

/** Seconds until a pending host timer fires, ticking once a second. */
function TimerNote({ dueAt }: { dueAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const seconds = Math.max(0, Math.ceil((dueAt - now) / 1000));
  return <span className="chat-waiting__state">Deadline in {seconds}s</span>;
}

// SSR paints the welcome chips seconds before React hydrates in dev; clicks
// in that window silently no-op. Gate interactive starters on hydration so
// the not-yet-wired state is visibly disabled instead of a dead button.
const noopSubscribe = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function textFromAppend(message: AppendMessage): string {
  return message.content
    .filter(
      (part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function AppPanel({
  intro,
  starters,
  turns,
  liveSteps,
  liveText,
  pendingIdle,
  startForm,
  onSubmit,
  onSendEvent,
  onCancel,
  onRestart,
  textPolicy,
}: AppPanelProps) {
  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const lastReady = [...turns].reverse().find((turn) => turn.status === "ready")?.result;
  const finished = Boolean(
    !pendingIdle && !loading && started && lastReady && lastReady.status !== "idle",
  );
  const messages = messagesFromTurns(turns, liveSteps, liveText);
  const hydrated = useHydrated();
  // When the soonest pending host timer fires, fixed once per idle result.
  const [timerDueAt, setTimerDueAt] = useState<number | null>(null);
  useEffect(() => {
    const delays = (pendingIdle?.timers ?? []).map((timer) => timer.delay);
    setTimerDueAt(delays.length ? Date.now() + Math.min(...delays) : null);
  }, [pendingIdle]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: loading,
    isDisabled: loading || !textPolicy.visible || finished,
    onNew: async (message) => {
      const text = textFromAppend(message);
      if (text) onSubmit(text);
    },
    // The composer's stop square while running — aborts the server run.
    onCancel: async () => onCancel(),
  });

  const Welcome = () => (
    <div className="aui-demo-welcome mx-auto my-auto flex w-full max-w-md flex-col gap-4 px-4 py-8">
      {intro}
      {starters.length ? (
        <div
          className="aui-thread-welcome-suggestions flex w-full flex-wrap justify-center gap-2"
          role="group"
          aria-label="Start a run"
        >
          {starters.map((starter) => (
            <Button
              key={starter.label}
              variant="ghost"
              disabled={loading || !hydrated}
              onClick={starter.onStart}
              className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto max-w-full gap-1.5 rounded-xl border px-3.5 py-1.5 text-center text-sm font-normal whitespace-normal transition-colors sm:rounded-full"
            >
              {/* A starter can be a whole essay: clamped, so every starter
                  fits above the composer; the full text is its title. */}
              <span className="line-clamp-3" title={starter.label}>
                {starter.label}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
      {startForm ? <StartFormCard schema={startForm.schema} onStart={startForm.onStart} /> : null}
      <p className="chat-intro__hint">The machine on the right updates with every reply.</p>
    </div>
  );

  const ComposerBefore =
    pendingIdle && !loading
      ? () => (
          <div className="aui-demo-actions flex flex-col gap-3 px-1">
            <div className="chat-waiting" role="status">
              <div className="chat-waiting__row">
                <span className="chat-waiting__dot" aria-hidden="true" />
                <span className="chat-waiting__label">Machine is waiting for you</span>
                {pendingIdle.component ? (
                  <span className="chat-waiting__state">{pendingIdle.component}</span>
                ) : null}
                {timerDueAt !== null ? <TimerNote dueAt={timerDueAt} /> : null}
              </div>
              {pendingIdle.prompt ? (
                <p className="chat-waiting__prompt">{pendingIdle.prompt}</p>
              ) : null}
            </div>
            <EventActions idle={pendingIdle} onSendEvent={onSendEvent} />
          </div>
        )
      : undefined;
  const ComposerAfter = textPolicy.note
    ? () => <p className="aui-demo-note px-2 text-xs text-muted-foreground">{textPolicy.note}</p>
    : undefined;
  const ComposerReplacement = finished
    ? () => (
        <div className="flex justify-end px-1">
          <Button variant="outline" onClick={onRestart}>
            <RefreshCcw aria-hidden="true" />
            Run again
          </Button>
        </div>
      )
    : undefined;

  const components: ThreadComponents = {
    Welcome,
    // Transitions render as an interleaved log, not collapsed "tool calls" —
    // this UI demonstrates the library, so the machine's steps ARE the content.
    ToolGroup: TransitionStrip,
    ToolFallback: TransitionChip,
    ComposerBefore,
    ComposerAfter,
    ComposerReplacement,
    composerPlaceholder: loading ? "Agent is working…" : textPolicy.placeholder,
    composerDisabled: loading || !textPolicy.visible,
  };

  return (
    <section className="work-panel app-panel" aria-label="Running app">
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread components={components} />
      </AssistantRuntimeProvider>
    </section>
  );
}
