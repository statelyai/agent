/**
 * Interleaved machine-transition log for the chat thread. This demo's purpose
 * is demonstrating the library, so every turn's transitions render inline —
 * event → state, with payload and inter-step timing — instead of hiding
 * behind a collapsed "tool calls" row. Transitions ride the thread as
 * tool-call parts (see `messagesFromTurns`); these components are the
 * renderers the thread is given for them.
 *
 * A row is a glance, not a record: it cuts the payload to one line. Every row
 * that has more to say opens, and what it opens to is the step in full — the
 * whole event the machine handled and the whole context it landed in.
 */
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { PropsWithChildren, ReactNode } from "react";
import type { TraceStep } from "@/lib/trace-view";

/** Container for a turn's consecutive transitions (ToolGroup override). */
export function TransitionStrip({ children }: PropsWithChildren) {
  return (
    <div className="transition-strip" role="log" aria-label="Machine transitions">
      {children}
    </div>
  );
}

type TransitionArgs = Partial<Pick<TraceStep, "state" | "payload" | "kind" | "detail">> & {
  /** Milliseconds since the previous step (0 for the first). */
  gap?: number;
};

/** The step's halves, in reading order, skipping the ones it doesn't have. */
function detailSections(detail: TraceStep["detail"]): Array<[string, unknown]> {
  if (!detail) return [];
  return (
    [
      ["Event", detail.event],
      ["Context", detail.context],
    ] as Array<[string, unknown]>
  ).filter(([, value]) => value !== null && value !== undefined);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One transition row (ToolFallback override — `args` carries the step). */
export const TransitionChip: ToolCallMessagePartComponent = ({ toolName, args }) => {
  const { state, payload, kind = "model", gap = 0, detail = null } = (args ?? {}) as TransitionArgs;
  const sections = detailSections(detail);
  const row: ReactNode = (
    <>
      {/* Always rendered, hidden when there is nothing to open, so expandable
          and plain rows keep one left edge. */}
      <span
        className="transition-chip__caret"
        aria-hidden="true"
        data-empty={sections.length ? undefined : "true"}
      >
        ▸
      </span>
      <span className="transition-chip__dot" aria-hidden="true" />
      <span className="transition-chip__event">
        {toolName}
        {kind === "done" ? " ✓" : kind === "error" || kind === "rejected" ? " ✗" : ""}
        {kind === "leg" ? " — a new run picks the story up here" : ""}
      </span>
      {payload ? <span className="transition-chip__payload">{payload}</span> : null}
      {/* An emit or a refused decision moves nothing, so it gets no target. */}
      {kind === "emit" || kind === "rejected" || kind === "leg" ? null : (
        <>
          <span className="transition-chip__arrow" aria-hidden="true">
            →
          </span>
          <span className="transition-chip__state" title={state}>
            {state}
          </span>
        </>
      )}
      {gap >= 100 ? (
        <span className="transition-chip__time">+{(gap / 1000).toFixed(1)}s</span>
      ) : null}
    </>
  );

  // No disclosure on a step whose row already is the whole step — an empty
  // twisty would promise data that isn't there.
  if (!sections.length) {
    return (
      <div className="transition-chip" data-kind={kind}>
        <div className="transition-chip__row">{row}</div>
      </div>
    );
  }

  return (
    <details className="transition-chip" data-kind={kind}>
      <summary className="transition-chip__row">{row}</summary>
      <div className="transition-chip__detail">
        {sections.map(([label, value]) => (
          <div className="transition-chip__section" key={label}>
            <span className="transition-chip__section-label">{label}</span>
            <pre className="transition-chip__json">{formatJson(value)}</pre>
          </div>
        ))}
      </div>
    </details>
  );
};
