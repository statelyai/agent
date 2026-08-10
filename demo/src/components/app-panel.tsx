import { useSyncExternalStore, type ReactNode } from "react";
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
  eventType?: string;
  status: "loading" | "ready" | "error" | "ignored";
  result?: ChatTurnResult;
  error?: string;
};

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
  pendingIdle: ChatIdle | null;
  startForm: { schema: JsonObject; onStart: (values: Record<string, unknown>) => void } | null;
  onSubmit: (value: string) => void;
  onSendEvent: (event: { type: string; [key: string]: unknown }) => void;
  /** Aborts the in-flight run (composer stop button). */
  onCancel: () => void;
  onRestart: () => void;
  /** Idle waits this run has settled at — the time-travel rail. */
  checkpoints: CheckpointChip[];
  /** Truncate the conversation back to a checkpoint and fork from there. */
  onRewind: (turnId: number) => void;
  textPolicy: TextPolicy;
};

export type CheckpointChip = { turnId: number; label: string };

/**
 * The checkpoint rail: every idle wait is a persisted snapshot the run can be
 * rewound to — click one, answer differently, and the conversation forks.
 */
function CheckpointRail({
  checkpoints,
  currentTurnId,
  onRewind,
}: {
  checkpoints: CheckpointChip[];
  /** The checkpoint that IS the current wait (not rewindable), if any. */
  currentTurnId: number | null;
  onRewind: (turnId: number) => void;
}) {
  return (
    <div className="checkpoint-rail" role="group" aria-label="Checkpoints">
      <span className="checkpoint-rail__title">Checkpoints</span>
      {checkpoints.map((checkpoint, index) => {
        const current = checkpoint.turnId === currentTurnId;
        return (
          <button
            key={checkpoint.turnId}
            className="checkpoint-rail__chip"
            data-current={current || undefined}
            disabled={current}
            title={current ? `${checkpoint.label} (current)` : `Rewind to: ${checkpoint.label}`}
            onClick={() => onRewind(checkpoint.turnId)}
          >
            <span className="checkpoint-rail__index">{index + 1}</span>
            <span className="checkpoint-rail__label">{checkpoint.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function resultState(result: ChatTurnResult): string {
  const committed = result.trace.filter(
    (entry) => entry.event.type !== "xstate.init" && entry.event.type !== "@xstate.init",
  );
  const last = committed[committed.length - 1];
  return last ? stateValueLabel(last.value) : result.mode;
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
      gap: index === 0 ? 0 : step.at - steps[index - 1].at,
    },
    result: step.state,
  }));
}

function messagesFromTurns(turns: Turn[], liveSteps: TraceStep[]): ThreadMessageLike[] {
  return turns.flatMap((turn, index): ThreadMessageLike[] => {
    const isLast = index === turns.length - 1;
    const userMessage: ThreadMessageLike = {
      id: `turn-${turn.id}-user`,
      role: "user",
      content: [
        {
          type: "text",
          text:
            turn.role === "action" && turn.eventType
              ? `${turn.input}\n\n\`${turn.eventType}\``
              : turn.input,
        },
      ],
    };

    if (turn.status === "loading") {
      // Live inspection fills the transition log in as the run happens; the
      // authoritative server trace replaces it at settle.
      if (!isLast || liveSteps.length === 0) return [userMessage];
      return [
        userMessage,
        {
          id: `turn-${turn.id}-assistant`,
          role: "assistant",
          content: transitionPartsFor(turn.id, liveSteps, "live"),
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

    if (turn.status === "error") {
      return [
        userMessage,
        {
          id: `turn-${turn.id}-assistant`,
          role: "assistant",
          content: turn.error ?? "Agent request failed.",
          status: {
            type: "incomplete",
            reason: "error",
            error: turn.error ?? "Agent request failed",
          },
        },
      ];
    }

    if (!turn.result) return [userMessage];

    const transitionParts = transitionPartsFor(turn.id, traceSteps(turn.result.trace), "transition");
    const response =
      turn.result.response ||
      (turn.result.status === "done" ? "The machine reached its final state." : "Ready.");

    return [
      userMessage,
      {
        id: `turn-${turn.id}-assistant`,
        role: "assistant",
        content: [...transitionParts, { type: "text", text: response }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: { state: resultState(turn.result) } },
      },
    ];
  });
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
  pendingIdle,
  startForm,
  onSubmit,
  onSendEvent,
  onCancel,
  onRestart,
  checkpoints,
  onRewind,
  textPolicy,
}: AppPanelProps) {
  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const lastReady = [...turns].reverse().find((turn) => turn.status === "ready")?.result;
  const finished = Boolean(
    !pendingIdle && !loading && started && lastReady && lastReady.status !== "idle",
  );
  const messages = messagesFromTurns(turns, liveSteps);
  const hydrated = useHydrated();

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
    <div className="aui-demo-welcome mx-auto flex w-full max-w-md flex-col gap-4 px-4">
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
              className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto max-w-full gap-1.5 rounded-xl border px-3.5 py-1.5 text-center text-sm font-normal whitespace-normal transition-colors sm:rounded-full sm:whitespace-nowrap"
            >
              {starter.label}
            </Button>
          ))}
        </div>
      ) : null}
      {startForm ? <StartFormCard schema={startForm.schema} onStart={startForm.onStart} /> : null}
    </div>
  );
  // The current wait's own checkpoint is shown but not rewindable; earlier
  // ones (and all of them once the run finishes) rewind + fork.
  const currentCheckpointTurnId =
    pendingIdle && checkpoints.length ? checkpoints[checkpoints.length - 1].turnId : null;
  const rail =
    !loading && (checkpoints.length > 1 || (checkpoints.length === 1 && !pendingIdle)) ? (
      <CheckpointRail
        checkpoints={checkpoints}
        currentTurnId={currentCheckpointTurnId}
        onRewind={onRewind}
      />
    ) : null;

  const ComposerBefore =
    pendingIdle && !loading
      ? () => (
          <div className="aui-demo-actions flex flex-col gap-3 px-1">
            {rail}
            <div className="chat-waiting" role="status">
              <div className="chat-waiting__row">
                <span className="chat-waiting__dot" aria-hidden="true" />
                <span className="chat-waiting__label">Machine is waiting for you</span>
                {pendingIdle.component ? (
                  <span className="chat-waiting__state">{pendingIdle.component}</span>
                ) : null}
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
        <div className="flex flex-col gap-3 px-1">
          {rail}
          <div className="flex justify-end">
            <Button variant="outline" onClick={onRestart}>
              <RefreshCcw aria-hidden="true" />
              Run again
            </Button>
          </div>
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
