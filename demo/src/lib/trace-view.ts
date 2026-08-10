/**
 * Client-side helpers for rendering the server-returned transition trace.
 * The client never runs a machine — it replays the real trace the server
 * captured from `runAgent`.
 */
import type { TraceEntry } from "./agent-runner";

/** Flattens an XState state value (string or nested object) to a readable label. */
export function stateValueLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "unknown";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => `${key}.${stateValueLabel(child)}`)
    .join(" · ");
}

/** Turns an internal/model event into a human label. */
export function prettifyEvent(event: { type: string; actorId?: unknown }): {
  label: string;
  kind: "model" | "done" | "error" | "system";
} {
  const { type } = event;
  // Done/error events may carry the actor id as a field (server trace) or as
  // a type suffix ("xstate.done.actor.0.foo" — live inspection stream).
  if (type.startsWith("xstate.done.actor")) {
    const suffix = type.slice("xstate.done.actor.".length).replace(/^\d+\./, "");
    const label = typeof event.actorId === "string" ? event.actorId : suffix || type;
    return { label, kind: "done" };
  }
  if (type.startsWith("xstate.error.actor")) {
    const suffix = type.slice("xstate.error.actor.".length).replace(/^\d+\./, "");
    const label = typeof event.actorId === "string" ? event.actorId : suffix || type;
    return { label, kind: "error" };
  }
  if (type.startsWith("xstate.") || type.startsWith("@xstate.")) {
    return { label: type, kind: "system" };
  }
  return { label: type, kind: "model" };
}

export type TraceStep = {
  /** Event label (no status glyphs — `kind` carries done/error). */
  label: string;
  /** The state value the machine landed in after this event. */
  state: string;
  /** Compact `key: value` rendering of the event payload, "" when none. */
  payload: string;
  kind: "model" | "done" | "error" | "system";
  /** Milliseconds since run start (from the server-captured trace). */
  at: number;
};

/**
 * Builds a TraceStep from a live inspection `actorSnapshot` message, so the
 * chat's transition log can fill in DURING a run (the authoritative server
 * trace replaces it at settle). Lifecycle noise (`init`/`stop`) returns null.
 */
export function liveTraceStep(event: unknown, stateValue: unknown, at: number): TraceStep | null {
  const source = event && typeof event === "object" ? (event as Record<string, unknown>) : null;
  const rawType = source?.type;
  if (typeof rawType !== "string") return null;
  const type = rawType.replace(/^@/, "");
  if (type === "xstate.init" || type === "xstate.stop") return null;
  const { label, kind } = prettifyEvent({ ...source, type } as { type: string });
  if (kind === "system") return null;
  const payload = Object.entries(source ?? {})
    .filter(
      ([key, value]) =>
        key !== "type" &&
        (typeof value === "number" ||
          typeof value === "boolean" ||
          (typeof value === "string" && value.length <= 60)),
    )
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  return { label, state: stateValueLabel(stateValue), payload, kind, at };
}

/** Derives the transition steps shown in the app panel from a trace. */
export function traceSteps(trace: TraceEntry[]): TraceStep[] {
  return trace
    .filter((entry) => entry.event.type !== "xstate.init" && entry.event.type !== "@xstate.init")
    .map((entry) => {
      const { label, kind } = prettifyEvent(entry.event);
      const payload = Object.entries(entry.event)
        .filter(([key]) => key !== "type")
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      return { label, state: stateValueLabel(entry.value), payload, kind, at: entry.at };
    });
}
