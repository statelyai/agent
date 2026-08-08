/**
 * Interleaved machine-transition log for the chat thread. This demo's purpose
 * is demonstrating the library, so every turn's transitions render inline —
 * event → state, with payload and inter-step timing — instead of hiding
 * behind a collapsed "tool calls" row. Transitions ride the thread as
 * tool-call parts (see `messagesFromTurns`); these components are the
 * renderers the thread is given for them.
 */
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { PropsWithChildren } from "react";
import type { TraceStep } from "@/lib/trace-view";

/** Container for a turn's consecutive transitions (ToolGroup override). */
export function TransitionStrip({ children }: PropsWithChildren) {
  return (
    <div className="transition-strip" role="log" aria-label="Machine transitions">
      {children}
    </div>
  );
}

type TransitionArgs = Partial<Pick<TraceStep, "state" | "payload" | "kind">> & {
  /** Milliseconds since the previous step (0 for the first). */
  gap?: number;
};

/** One transition row (ToolFallback override — `args` carries the step). */
export const TransitionChip: ToolCallMessagePartComponent = ({ toolName, args }) => {
  const { state, payload, kind = "model", gap = 0 } = (args ?? {}) as TransitionArgs;
  return (
    <div className="transition-chip" data-kind={kind}>
      <span className="transition-chip__dot" aria-hidden="true" />
      <span className="transition-chip__event">
        {toolName}
        {kind === "done" ? " ✓" : kind === "error" ? " ✗" : ""}
      </span>
      {payload ? <span className="transition-chip__payload">{payload}</span> : null}
      <span className="transition-chip__arrow" aria-hidden="true">
        →
      </span>
      <span className="transition-chip__state">{state}</span>
      {gap >= 100 ? (
        <span className="transition-chip__time">+{(gap / 1000).toFixed(1)}s</span>
      ) : null}
    </div>
  );
};
