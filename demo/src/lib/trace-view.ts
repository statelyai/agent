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
  // An anonymous invoke's id is its own state path, which xstate prefixes with
  // the system index ("0.reflection.drafting"). That index addresses nothing a
  // reader can use, so it goes — a named invoke ("writeEssay") is untouched.
  const actorLabel = (fallback: string) => {
    const id = typeof event.actorId === "string" && event.actorId ? event.actorId : fallback;
    return id.replace(/^\d+\./, "") || type;
  };
  // Done/error events may carry the actor id as a field (server trace) or as
  // a type suffix ("xstate.done.actor.0.foo" — live inspection stream).
  if (type.startsWith("xstate.done.actor")) {
    return { label: actorLabel(type.slice("xstate.done.actor.".length)), kind: "done" };
  }
  if (type.startsWith("xstate.error.actor")) {
    return { label: actorLabel(type.slice("xstate.error.actor.".length)), kind: "error" };
  }
  if (type.startsWith("xstate.") || type.startsWith("@xstate.")) {
    return { label: type, kind: "system" };
  }
  return { label: type, kind: "model" };
}

/**
 * Event fields that identify an actor rather than describe the work it did.
 * The row's own label already names the actor, so repeating `actorId` — and
 * printing a `sessionId` nobody can act on — crowds out the only part of a
 * step worth reading.
 */
const PLUMBING_FIELDS = new Set([
  "type",
  "actorId",
  "sessionId",
  "parentSessionId",
  "rootId",
  "snapshot",
  "machine",
]);

/** Longest single value rendered inline before it is cut with an ellipsis. */
const VALUE_CHARS = 48;
/** Longest whole payload; a step is a glance, not a record. */
const PAYLOAD_CHARS = 96;
/** Most fields shown from one event, so a wide payload cannot bury the row. */
const PAYLOAD_FIELDS = 3;

function clamp(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** A bag of fields worth hoisting — not an array, a date, or an `Error`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !(value instanceof Date)
  );
}

/** One value as a glanceable string, or null when there is nothing to show. */
function previewValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return clamp(value, VALUE_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.length === 1 ? "1 item" : `${value.length} items`;
  }
  if (value instanceof Error) return clamp(value.message, VALUE_CHARS);
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) return previewFields(value) || "{…}";
  return null;
}

/** `key: value` pairs for an object's own readable fields. */
function previewFields(source: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (PLUMBING_FIELDS.has(key)) continue;
    if (parts.length === PAYLOAD_FIELDS) break;
    const preview = previewValue(value);
    if (preview !== null) parts.push(`${key}: ${preview}`);
  }
  return parts.join(", ");
}

/**
 * The work a transition did, as one short line: the event's own fields, with
 * an actor result (`output`) or failure (`error`) hoisted out of its wrapper
 * so a completed request reads `score: 6, verdict: revise` rather than
 * `output: {…}`. Returns "" when the event carries nothing to show.
 */
export function summarizePayload(event: Record<string, unknown>): string {
  const outcome = "output" in event ? event["output"] : "error" in event ? event["error"] : undefined;
  const hoisted = isPlainObject(outcome) ? previewFields(outcome) : previewValue(outcome);
  const rest = previewFields(
    Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== "output" && key !== "error"),
    ),
  );
  const summary = [hoisted, rest].filter(Boolean).join(", ");
  return clamp(summary, PAYLOAD_CHARS);
}

export type TraceStep = {
  /** Event label (no status glyphs — `kind` carries done/error). */
  label: string;
  /** The state value the machine landed in after this event. */
  state: string;
  /** What the step produced, as one short line — see {@link summarizePayload}. */
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
  const payload = summarizePayload(source ?? {});
  return { label, state: stateValueLabel(stateValue), payload, kind, at };
}

/** Derives the transition steps shown in the app panel from a trace. */
export function traceSteps(trace: TraceEntry[]): TraceStep[] {
  return trace
    .filter((entry) => entry.event.type !== "xstate.init" && entry.event.type !== "@xstate.init")
    .map((entry) => {
      const { label, kind } = prettifyEvent(entry.event);
      const payload = summarizePayload(entry.event);
      return { label, state: stateValueLabel(entry.value), payload, kind, at: entry.at };
    });
}
