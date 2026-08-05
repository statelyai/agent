import type { ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  ThreadPrimitive,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { RefreshCcw } from "lucide-react";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/thread";
import { EventActions, StartFormCard } from "@/components/event-actions";
import { Button } from "@/components/ui/button";
import type { StarterAction } from "@/components/chat-intros";
import type { TraceEntry } from "@/lib/agent-runner";
import type { ChatIdle, JsonObject } from "@/lib/machine-ui";
import { stateValueLabel, traceSteps } from "@/lib/trace-view";

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
  pendingIdle: ChatIdle | null;
  startForm: { schema: JsonObject; onStart: (values: Record<string, unknown>) => void } | null;
  onSubmit: (value: string) => void;
  onSendEvent: (event: { type: string; [key: string]: unknown }) => void;
  onRestart: () => void;
  textPolicy: TextPolicy;
};

function resultState(result: ChatTurnResult): string {
  const committed = result.trace.filter(
    (entry) => entry.event.type !== "xstate.init" && entry.event.type !== "@xstate.init",
  );
  const last = committed[committed.length - 1];
  return last ? stateValueLabel(last.value) : result.mode;
}

function messagesFromTurns(turns: Turn[]): ThreadMessageLike[] {
  return turns.flatMap((turn): ThreadMessageLike[] => {
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

    if (turn.status === "loading") return [userMessage];

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

    const transitionParts = traceSteps(turn.result.trace).map((step, index) => ({
      type: "tool-call" as const,
      toolCallId: `turn-${turn.id}-transition-${index}`,
      toolName: step.title.replace(/\s[✓✗]$/, ""),
      args: {},
      result: step.detail.replace(/^→\s*/, ""),
    }));
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
  pendingIdle,
  startForm,
  onSubmit,
  onSendEvent,
  onRestart,
  textPolicy,
}: AppPanelProps) {
  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const lastReady = [...turns].reverse().find((turn) => turn.status === "ready")?.result;
  const finished = Boolean(
    !pendingIdle && !loading && started && lastReady && lastReady.status !== "idle",
  );
  const messages = messagesFromTurns(turns);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: loading,
    isDisabled: loading || !textPolicy.visible || finished,
    onNew: async (message) => {
      const text = textFromAppend(message);
      if (!text) return;
      const starter = !started ? starters.find((candidate) => candidate.label === text) : undefined;
      if (starter) starter.onStart();
      else onSubmit(text);
    },
  });

  const Welcome = () => (
    <div className="aui-demo-welcome mx-auto flex w-full max-w-md flex-col gap-4 px-4">
      {intro}
      {starters.length ? (
        <div
          className="aui-thread-welcome-suggestions flex w-full flex-wrap justify-center gap-2"
          role="group"
          aria-label="Prefill message"
        >
          {starters.map((starter) => (
            <ThreadPrimitive.Suggestion
              key={starter.label}
              prompt={starter.label}
              method="replace"
              render={
                <Button
                  variant="ghost"
                  className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto max-w-full gap-1.5 rounded-xl border px-3.5 py-1.5 text-center text-sm font-normal whitespace-normal transition-colors sm:rounded-full sm:whitespace-nowrap"
                />
              }
            >
              {starter.label}
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      ) : null}
      {startForm ? <StartFormCard schema={startForm.schema} onStart={startForm.onStart} /> : null}
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
