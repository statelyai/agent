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
  if (type === "xstate.done.actor") {
    return { label: typeof event.actorId === "string" ? event.actorId : type, kind: "done" };
  }
  if (type === "xstate.error.actor") {
    return { label: typeof event.actorId === "string" ? event.actorId : type, kind: "error" };
  }
  if (type.startsWith("xstate.") || type.startsWith("@xstate.")) {
    return { label: type, kind: "system" };
  }
  return { label: type, kind: "model" };
}

export type TraceStep = {
  title: string;
  detail: string;
  kind: "model" | "done" | "error" | "system";
};

/** Derives the event chips shown in the app panel from a trace. */
export function traceSteps(trace: TraceEntry[]): TraceStep[] {
  return trace
    .filter((entry) => entry.event.type !== "xstate.init" && entry.event.type !== "@xstate.init")
    .map((entry) => {
      const { label, kind } = prettifyEvent(entry.event);
      const payload = Object.entries(entry.event)
        .filter(([key]) => key !== "type")
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      return {
        title: kind === "done" ? `${label} ✓` : kind === "error" ? `${label} ✗` : label,
        detail: `→ ${stateValueLabel(entry.value)}${payload ? ` · ${payload}` : ""}`,
        kind,
      };
    });
}
