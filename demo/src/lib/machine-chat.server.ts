/**
 * Generic machine chat (server): runs ANY exported agent machine and shapes
 * what a unified chat UI needs, with no per-machine code.
 *
 * - Accepted events come from `getAcceptedEvents` on the live snapshot, with
 *   payload schemas from the machine's own `setupAgent` event schemas.
 * - Payload schemas are converted to JSON Schema (Standard Schema
 *   `~standard.jsonSchema`, falling back to Zod's `z.toJSONSchema`) so the
 *   client can generate a form.
 * - Optional `meta.interaction` hints (label / events / textEvent) refine the
 *   presentation — see `machine-ui.ts` for the convention.
 */
import {
  getAcceptedEvents,
  getAgentSchemas,
  getStateMeta,
  parseAgentEvent,
  runAgent,
  type AgentRequestExecutors,
  type RunAgentResult,
} from "@statelyai/agent";
import type { AnyMachineSnapshot, AnyStateMachine, Snapshot } from "xstate";
import { z } from "zod";
import { maybeCreateRunInspection } from "./inspection.server";
import {
  humanizeEventType,
  humanizeFieldName,
  schemaNeedsPayload,
  singleStringField,
  type AcceptedEvent,
  type ChatIdle,
  type Json,
  type JsonObject,
} from "./machine-ui";

// ─── trace capture (shared with the curated scenario runner) ───

/**
 * What a trace entry records. `transition` is a committed machine transition;
 * the other two are the work that happens BETWEEN transitions and would
 * otherwise never reach the reader:
 *
 * - `emitted` — an `enq.emit(...)` the machine author chose to announce, so a
 *   long run says what it is doing instead of going quiet.
 * - `rejected` — a decision the machine refused (`unknown-event`,
 *   `invalid-payload`, `rejected-by-guard`) before retrying. The guard turning
 *   down an illegal choice is the clearest evidence the machine is doing its
 *   job, and it used to be invisible.
 * - `leg` — a second run starting inside one story. Multi-run examples (a
 *   crash and its recovery, a snapshot resumed on a new machine version) record
 *   both runs into one trace, and without a marker the seam between them — the
 *   whole point of those examples — reads as just another transition.
 */
export type TraceEntryKind = "transition" | "emitted" | "rejected" | "leg";

export type TraceEntry = {
  event: { type: string } & Record<string, Json>;
  value: Json;
  context: Record<string, Json>;
  /** Milliseconds since run start — the client replays with proportional timing. */
  at: number;
  /** Defaults to `transition` when absent, so older traces still read. */
  kind?: TraceEntryKind;
  /**
   * The step unabridged, for the row's expandable detail: the whole event and
   * (for a transition) the whole context it landed in. `event`/`context` above
   * are cut down to what fits one line; this is what a reader opens the row to
   * see — the model's full output, the context field that actually changed.
   */
  detail?: { event: Json | null; context?: Json | null };
};

/**
 * Collects a run's transitions with real elapsed-time stamps, and tracks which
 * context keys the run actually changed (most recent first). Values present at
 * init — or in `baselineContext`, for resumed snapshots — don't count as
 * changes, so input echoes stay out of the "work produced" set.
 */
export function createTraceRecorder(baselineContext?: unknown): {
  trace: TraceEntry[];
  onTransition: (snapshot: AnyMachineSnapshot, event: unknown) => void;
  /** `runAgent`'s `on` handler: records an `enq.emit(...)` the machine made. */
  onEmitted: (event: unknown) => void;
  /** `runAgent`'s `trace` handler: records decisions the machine refused. */
  onTrace: (entry: unknown) => void;
  changedKeys: () => string[];
  /** The last full context seen — the "work so far" when a run is cut short. */
  latestContext: () => unknown;
} {
  const trace: TraceEntry[] = [];
  const startedAt = Date.now();
  const lastValues = new Map<string, string>();
  const changedAt = new Map<string, number>();
  let step = 0;
  let latest: unknown = baselineContext;

  const serialize = (value: unknown): string => {
    try {
      return JSON.stringify(value) ?? "undefined";
    } catch {
      return String(value);
    }
  };
  const observe = (context: unknown, markChanges: boolean) => {
    if (!context || typeof context !== "object") return;
    for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
      const serialized = serialize(value);
      if (lastValues.get(key) === serialized) continue;
      lastValues.set(key, serialized);
      if (markChanges) changedAt.set(key, step);
    }
    step += 1;
  };
  if (baselineContext !== undefined) observe(baselineContext, false);

  // Entries that are not transitions carry the state the run was in when they
  // happened, so a row still reads as part of the sequence around it.
  let lastValue: Json = null;
  // Attempts recorded so far per request id, so a retry's growing list is
  // recorded once. The id is the invoke id, which repeats when a machine
  // re-enters the same decision, so a list that is no longer than the last one
  // is a NEW invocation rather than more of the old one.
  const attemptsSeen = new Map<string, number>();

  const push = (kind: TraceEntryKind, event: unknown) => {
    trace.push({
      at: Date.now() - startedAt,
      event: smallEvent(event),
      value: lastValue,
      context: {},
      kind,
      detail: { event: traceDetail(event) },
    });
  };

  return {
    trace,
    onTransition: (snapshot, event) => {
      const type = String((event as { type?: unknown } | null)?.type ?? "");
      const isInit = type === "xstate.init" || type === "@xstate.init";
      // An init after work has already been recorded is a NEW run continuing
      // the same story, not the beginning of one.
      if (isInit && trace.length > 0) push("leg", { type: "run.resumed" });
      observe(snapshot.context, !isInit);
      latest = snapshot.context;
      lastValue = snapshot.value as Json;
      trace.push({
        at: Date.now() - startedAt,
        event: smallEvent(event),
        value: snapshot.value as Json,
        context: smallContext(snapshot.context),
        kind: "transition",
        detail: { event: traceDetail(event), context: traceDetail(snapshot.context) },
      });
    },
    onEmitted: (event) => push("emitted", event),
    onTrace: (entry) => {
      // A decision retries by re-issuing `request.start` with the failed
      // attempts appended, so only the ones this start added are recorded.
      // There is no dedicated "rejected" trace event to listen to.
      const step = entry as { type?: unknown; request?: { id?: unknown; attempts?: unknown } };
      if (step?.type !== "request.start") return;
      const attempts = step.request?.attempts;
      if (!Array.isArray(attempts)) return;
      const id = String(step.request?.id ?? "");
      const recorded = attemptsSeen.get(id) ?? 0;
      const from = attempts.length > recorded ? recorded : 0;
      attemptsSeen.set(id, attempts.length);
      attempts.slice(from).forEach((attempt) => {
        const { event, failure, reason } = (attempt ?? {}) as {
          event?: { type?: unknown };
          failure?: unknown;
          reason?: unknown;
        };
        push("rejected", {
          type: typeof event?.type === "string" ? event.type : "(no event)",
          failure: String(failure ?? "rejected"),
          reason: String(reason ?? ""),
        });
      });
    },
    changedKeys: () => [...changedAt.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key),
    latestContext: () => latest,
  };
}

export function smallContext(context: unknown): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (!context || typeof context !== "object") return out;
  for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value ?? null;
    } else if (typeof value === "string") {
      out[key] = value.length > 140 ? `${value.slice(0, 140)}…` : value;
    } else if (Array.isArray(value)) {
      out[key] = `Array(${value.length})`;
    }
  }
  return out;
}

/**
 * Bounds for the expandable detail. Generous — the point of opening a row is
 * to read what the step actually produced — but never unbounded: a trace rides
 * the chat response, and one runaway field would take the turn with it.
 */
const DETAIL_STRING_CHARS = 4000;
const DETAIL_ARRAY_ITEMS = 40;
const DETAIL_OBJECT_FIELDS = 64;
const DETAIL_DEPTH = 6;
const DETAIL_CHARS = 24_000;

/**
 * Event fields that carry a whole actor rather than data about the step. The
 * live inspection stream attaches these, and either one alone dwarfs every
 * other field in the detail view.
 */
const DETAIL_OMITTED_FIELDS = new Set(["snapshot", "machine"]);

function detailValue(value: unknown, depth: number): Json | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    return value.length > DETAIL_STRING_CHARS ? `${value.slice(0, DETAIL_STRING_CHARS)}…` : value;
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined; // functions, symbols, undefined
  if (depth >= DETAIL_DEPTH) return "(deeper)";
  if (Array.isArray(value)) {
    const items: Json[] = value
      .slice(0, DETAIL_ARRAY_ITEMS)
      .map((item) => detailValue(item, depth + 1) ?? null);
    if (value.length > DETAIL_ARRAY_ITEMS) {
      items.push(`… ${value.length - DETAIL_ARRAY_ITEMS} more`);
    }
    return items;
  }
  const out: Record<string, Json> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  // An event's own shape is the machine author's; a resumed one carries
  // whatever the client sent. A wide object is capped rather than trusted.
  for (const [key, field] of entries.slice(0, DETAIL_OBJECT_FIELDS)) {
    if (DETAIL_OMITTED_FIELDS.has(key)) continue;
    const kept = detailValue(field, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }
  if (entries.length > DETAIL_OBJECT_FIELDS) {
    out["…"] = `${entries.length - DETAIL_OBJECT_FIELDS} more fields`;
  }
  return out;
}

/**
 * A JSON-safe, bounded copy of an event or a context, for {@link TraceEntry}'s
 * `detail`. Null when there is nothing to open — an empty object, a value that
 * cannot cross the wire, or one so large that showing a prefix would mislead.
 */
export function traceDetail(value: unknown): Json | null {
  const detail = detailValue(value, 0);
  if (detail === undefined || detail === null) return null;
  let json: string;
  try {
    json = JSON.stringify(detail) ?? "";
  } catch {
    return null;
  }
  if (!json || json === "{}" || json === "[]") return null;
  return json.length > DETAIL_CHARS
    ? `(${Math.round(json.length / 1000)} KB — too large to show)`
    : detail;
}

/** Longest string kept on a trace event; the chat truncates further to a row. */
const TRACE_STRING_CHARS = 140;

/** One event field, bounded and JSON-safe, or `undefined` to drop it. */
function smallEventValue(value: unknown, nested: boolean): Json | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > TRACE_STRING_CHARS ? `${value.slice(0, TRACE_STRING_CHARS)}…` : value;
  }
  if (value instanceof Error) return smallEventValue(value.message, nested);
  // Phrased, not `Array(3)`: this lands in a chat row a person reads, and the
  // live-inspection path summarizes the same value the same way.
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
  // One level only: an actor's `output` is the work a step produced, and it is
  // usually a small object. Deeper than that is a record, not a chat row.
  if (!nested && value !== null && typeof value === "object") {
    const inner: Record<string, Json> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    // Capped like the top level: a resumed event's payload is the client's,
    // and one wide nested object should not become the whole response.
    for (const [key, field] of entries.slice(0, DETAIL_OBJECT_FIELDS)) {
      const small = smallEventValue(field, true);
      if (small !== undefined) inner[key] = small;
    }
    if (entries.length > DETAIL_OBJECT_FIELDS) {
      inner["…"] = `${entries.length - DETAIL_OBJECT_FIELDS} more fields`;
    }
    return Object.keys(inner).length > 0 ? inner : undefined;
  }
  return undefined;
}

/**
 * A trace event, bounded for the wire. Actor results (`output`) and failures
 * (`error`) keep one level of structure: without it the chat's transition log
 * can only say that a request finished, never what it produced — which is the
 * only part of an intermediate step worth reading.
 */
export function smallEvent(event: unknown): { type: string } & Record<string, Json> {
  if (!event || typeof event !== "object") return { type: String(event) };
  const source = event as Record<string, unknown>;
  const out: { type: string } & Record<string, Json> = { type: String(source.type ?? "event") };
  // The row shows three fields at most (see `summarizePayload`); the cap is
  // generous next to that, and keeps a wide client event off the wire.
  for (const [key, value] of Object.entries(source).slice(0, DETAIL_OBJECT_FIELDS)) {
    if (key === "type") continue;
    const small =
      key === "output" && isTextResultEnvelope(value)
        ? // A text request's `{ result, messages }`: the result is the work,
          // so it keeps its one level of structure; the messages are a count.
          {
            result: smallEventValue(value.result, false) ?? null,
            messages: smallEventValue(value.messages, true) ?? null,
          }
        : smallEventValue(value, false);
    if (small !== undefined) out[key] = small;
  }
  return out;
}

/** The `{ result, messages }` envelope every text request resolves to. */
function isTextResultEnvelope(value: unknown): value is { result: unknown; messages: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "result" in value &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

// ─── schema access ───

type MachineSchemas = {
  input?: unknown;
  events?: Record<string, unknown>;
};

/** The zod/standard schemas `setupAgent` stamped on the machine (if any). */
export function machineSchemas(machine: AnyStateMachine): MachineSchemas {
  // Registered by both setupAgent(...) and setupAgent.fromConfig(...) — the
  // only place a JSON-authored machine's schemas live.
  const registered = getAgentSchemas(machine);
  if (registered) return registered as MachineSchemas;
  // Plain xstate machines: schemas are on the machine/config itself.
  const direct = (machine as { schemas?: MachineSchemas }).schemas;
  if (direct && typeof direct === "object") return direct;
  const config = (machine as { config?: { schemas?: MachineSchemas } }).config;
  return config?.schemas ?? {};
}

/** Standard Schema / Zod → JSON Schema; null when not derivable. */
export function jsonSchemaOf(schema: unknown): JsonObject | null {
  if (!schema || typeof schema !== "object") return null;
  const standard = (schema as { "~standard"?: { jsonSchema?: { input?: () => unknown } } })[
    "~standard"
  ];
  const produce = standard?.jsonSchema?.input;
  if (typeof produce === "function") {
    try {
      const out = produce();
      if (out && typeof out === "object" && !(out instanceof Promise)) return out as JsonObject;
    } catch {
      // fall through to the zod path
    }
  }
  if ("_zod" in (schema as object)) {
    try {
      return z.toJSONSchema(schema as never, {
        io: "input",
        unrepresentable: "any",
      }) as JsonObject;
    } catch {
      return null;
    }
  }
  return null;
}

// ─── interaction hints (meta.interaction convention) ───

type InteractionHints = {
  /** A string with `{key}` placeholders, or a function of the context (see `interactionMetaSchema`). */
  label?: string | ((args: { context: unknown }) => string);
  events?: Record<string, { label?: string; style?: string }>;
  textEvent?: string;
  /** Custom composer renderer for this state ("rating", "cards", …). */
  component?: string;
};

function interactionHints(snapshot: AnyMachineSnapshot): InteractionHints {
  const meta = getStateMeta(snapshot) as { interaction?: InteractionHints };
  return meta.interaction && typeof meta.interaction === "object" ? meta.interaction : {};
}

/**
 * Resolve `{key}` placeholders in an interaction label against the snapshot's
 * context, so static `meta` can still surface runtime state (e.g.
 * `"{notice} Another round?"`). Missing or non-primitive keys resolve to "".
 */
export function resolveLabel(label: string, context: unknown): string {
  const source = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  return label
    .replace(/\{([\w.]+)\}/g, (_, path: string) => {
      // Dotted paths read nested context: `{employee.name}`.
      const value = path
        .split(".")
        .reduce<unknown>(
          (current, key) =>
            current && typeof current === "object"
              ? (current as Record<string, unknown>)[key]
              : undefined,
          source,
        );
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The deepest active state node's `description`, when authored. Machines that
 * never opted into `meta.interaction` still document themselves this way, so
 * it is the next-best idle prompt.
 */
function activeDescription(snapshot: AnyMachineSnapshot): string | null {
  const nodes = snapshot.nodes;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const description = nodes[index]?.description;
    if (typeof description === "string" && description.trim()) return description;
  }
  return null;
}

/** What an idle snapshot is waiting on, ready for the chat UI. */
export function describeIdle(machine: AnyStateMachine, snapshot: AnyMachineSnapshot): ChatIdle {
  const schemas = machineSchemas(machine);
  const hints = interactionHints(snapshot);

  const events: AcceptedEvent[] = getAcceptedEvents(snapshot, {
    events: schemas.events as never,
  }).map((descriptor) => {
    const jsonSchema = jsonSchemaOf(descriptor.inputSchema);
    const hint = hints.events?.[descriptor.type] ?? {};
    return {
      type: descriptor.type,
      label: hint.label
        ? resolveLabel(hint.label, snapshot.context)
        : humanizeEventType(descriptor.type),
      style: hint.style === "primary" || hint.style === "danger" ? hint.style : "default",
      jsonSchema,
      needsPayload: schemaNeedsPayload(jsonSchema),
    };
  });

  // Free text maps to the declared textEvent, or — when unambiguous — the one
  // accepted event whose payload is exactly one string field.
  const declared = hints.textEvent
    ? events.find((event) => event.type === hints.textEvent)
    : undefined;
  const inferable = events.filter((event) => singleStringField(event.jsonSchema));
  const chosen = declared ?? (inferable.length === 1 ? inferable[0] : undefined);
  const field = chosen ? singleStringField(chosen.jsonSchema) : null;

  // Prompt: the interaction label, else the active state node's description.
  // Both go through resolveLabel so `{key}` placeholders resolve either way.
  const rawPrompt =
    typeof hints.label === "function"
      ? hints.label({ context: snapshot.context })
      : typeof hints.label === "string"
        ? hints.label
        : activeDescription(snapshot);

  return {
    prompt: rawPrompt ? resolveLabel(rawPrompt, snapshot.context) : null,
    events,
    textEvent: chosen && field ? { type: chosen.type, field } : null,
    component: typeof hints.component === "string" && hints.component ? hints.component : null,
  };
}

// ─── machine input ───

export type MachineInputInfo = {
  jsonSchema: JsonObject | null;
  /** When the input schema is a single string field, chat text starts the run. */
  promptField: string | null;
};

export function describeMachineInput(machine: AnyStateMachine): MachineInputInfo {
  const jsonSchema = jsonSchemaOf(machineSchemas(machine).input);
  return { jsonSchema, promptField: singleStringField(jsonSchema) };
}

// ─── generic run / resume ───

/** Limits every live run gets: the request's abort signal and a time budget. */
export type RunLimits = {
  /** Fires on the user's Cancel or a closed tab (the HTTP request's signal). */
  signal?: AbortSignal;
  /** Wall-clock budget for the whole run; examples override via metadata. */
  budgetMs?: number;
  /** Raw source passed to Viz so v6 function transitions remain visible. */
  machineSource?: string;
};

export const DEFAULT_RUN_BUDGET_MS = 120_000;

/** One signal for runAgent: request abort OR time budget, whichever first. */
export function runSignal(limits: RunLimits): AbortSignal {
  const budget = AbortSignal.timeout(limits.budgetMs ?? DEFAULT_RUN_BUDGET_MS);
  return limits.signal ? AbortSignal.any([limits.signal, budget]) : budget;
}

export type MachineChatResult = {
  /** `walkthrough` when the server has no API key and placeholders stood in for the model. */
  mode: "live" | "walkthrough";
  model?: string;
  status: "done" | "idle" | "error";
  trace: TraceEntry[];
  response: string;
  output?: Json;
  idle?: ChatIdle & { snapshot: Json };
};

/**
 * Output → chat text. Strings pass through. Object outputs read as prose: the
 * longest string field becomes the body, remaining primitives a compact
 * "Key: value" list under it. The untouched value still ships as
 * `MachineChatResult.output` for anything that wants the raw JSON.
 */
export function renderOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const entries = Object.entries(output as Record<string, unknown>);
    const strings = entries.filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
    );
    if (strings.length) {
      const longest = strings.reduce((best, entry) =>
        entry[1].length > best[1].length ? entry : best,
      );
      // Only prose leads. An identifier-like longest string (a reference
      // code, a slug) is one more "Key: value" line, not the body.
      const [bodyKey, body] = /\s/.test(longest[1].trim()) ? longest : [null, null];
      const rest = entries.filter(
        ([key, value]) =>
          key !== bodyKey &&
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
      );
      // Bullets: a bare newline is not a line break in markdown.
      const list = rest.map(([key, value]) => `- ${humanizeFieldName(key)}: ${String(value)}`);
      // Nested values are still output — fenced JSON under their own heading,
      // never dropped.
      const nested = entries
        .filter(([key, value]) => key !== bodyKey && value !== null && typeof value === "object")
        .map(
          ([key, value]) =>
            `**${humanizeFieldName(key)}**\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
        );
      return [body, list.length ? list.join("\n") : null, ...nested]
        .filter((section): section is string => section !== null)
        .join("\n\n");
    }
  }
  try {
    return "```json\n" + JSON.stringify(output, null, 2) + "\n```";
  } catch {
    return String(output);
  }
}

/**
 * What the run produced so far, read generically off an idle snapshot: the
 * context values the run changed (per the trace recorder), most recent first.
 * Strings render before objects so prose (drafts, answers, SQL) leads; small
 * non-string values render as fenced JSON. Echoes of what the user just sent
 * (`omitValues`) are plumbing, not work — skipped. A message-history array
 * renders only its newest assistant message: the reply a chat loop keeps in
 * `messages` instead of a dedicated field.
 * Null when the run changed nothing presentable — the idle prompt alone is
 * then the whole story.
 */
export function renderIdleWork(
  context: unknown,
  changedKeys: string[],
  omitValues: string[] = [],
): string | null {
  const MAX_SECTIONS = 3;
  const MAX_STRING = 4000;
  const MAX_JSON = 1500;
  if (!context || typeof context !== "object") return null;
  const source = context as Record<string, unknown>;
  const omitted = new Set(omitValues.map((value) => value.trim()).filter(Boolean));
  const isMessageHistory = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item && typeof item === "object" && "role" in item && "content" in item);

  const strings: Array<{ key: string; body: string }> = [];
  const objects: Array<{ key: string; body: string }> = [];
  const latestReply = (history: unknown[]): string | null => {
    const last = history[history.length - 1] as { role: unknown; content: unknown };
    if (last.role !== "assistant") return null;
    const parts = Array.isArray(last.content) ? last.content : [last.content];
    const text = parts
      .map((part) =>
        typeof part === "string"
          ? part
          : part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("")
      .trim();
    return text || null;
  };

  for (const key of changedKeys) {
    const rawValue = source[key];
    const value = isMessageHistory(rawValue) ? latestReply(rawValue as unknown[]) : rawValue;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text || omitted.has(text)) continue;
      strings.push({
        key,
        body: text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text,
      });
    } else if (value && typeof value === "object") {
      let json: string;
      try {
        json = JSON.stringify(value, null, 2);
      } catch {
        continue;
      }
      if (!json || json === "{}" || json === "[]" || json.length > MAX_JSON) continue;
      objects.push({ key, body: "```json\n" + json + "\n```" });
    }
  }

  const sections = [...strings, ...objects].slice(0, MAX_SECTIONS);
  if (!sections.length) return null;
  if (sections.length === 1 && strings.length === 1) return sections[0].body;
  return sections
    .map((section) => `**${humanizeFieldName(section.key)}**\n\n${section.body}`)
    .join("\n\n");
}

function toChatResult(
  machine: AnyStateMachine,
  model: string | undefined,
  result: RunAgentResult<AnyStateMachine>,
  trace: TraceEntry[],
  changedKeys: string[],
  omitValues: string[],
  latestContext?: unknown,
  limits?: RunLimits,
): MachineChatResult {
  if (result.status === "done") {
    return {
      mode: "live",
      model,
      status: "done",
      trace,
      response: renderOutput(result.output),
      output: result.output as Json,
    };
  }
  if (result.status === "idle") {
    const idle = describeIdle(machine, result.snapshot);
    // Show the work the run produced (drafts, answers, queries…) — the idle
    // prompt ships separately in `idle` and renders in the waiting box, so
    // approvals aren't asked for sight unseen.
    const work = renderIdleWork(result.snapshot.context, changedKeys, omitValues);
    // An event the state has no transition for is ignored, not an error: say
    // so instead of re-showing the work as if the event had applied.
    const ignoredNote = result.ignored
      ? `"${result.ignored.type}" isn't an accepted event in this state, so nothing happened.`
      : null;
    return {
      mode: "live",
      model,
      status: "idle",
      trace,
      response: ignoredNote ?? work ?? idle.prompt ?? "The machine is idle, waiting for input.",
      // Resume from the run's persisted snapshot, not the live one — it
      // round-trips invoked children WITH their state (a long-lived agent
      // keeps its context across chat turns).
      idle: { ...idle, snapshot: result.persist() as unknown as Json },
    };
  }
  const error = (result as { error?: unknown }).error;
  const cause = (result as { cause?: string }).cause;
  // A budgeted stop isn't a failure — return the work captured so far.
  const stopNote =
    cause === "aborted"
      ? limits?.signal?.aborted
        ? "Run cancelled."
        : `Run stopped at its ${Math.round((limits?.budgetMs ?? DEFAULT_RUN_BUDGET_MS) / 1000)}s time budget.`
      : cause === "max-model-calls"
        ? "Run stopped at its model-call budget."
        : null;
  if (stopNote) {
    const work = renderIdleWork(latestContext, changedKeys, omitValues);
    return {
      mode: "live",
      model,
      status: "error",
      trace,
      response: work ? `${stopNote} Work so far:\n\n${work}` : stopNote,
    };
  }
  return {
    mode: "live",
    model,
    status: "error",
    trace,
    response: `The run ended with an error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

type ResolvedExecutors = {
  mode: "live" | "walkthrough";
  model?: string;
  executors: Partial<AgentRequestExecutors>;
};

/**
 * Live AI SDK executors that resolve EVERY model ref to one OpenAI model — or,
 * with no key on the server, schema-driven placeholders that let every
 * example's machine run anyway (see `walkthrough-executors.ts`).
 */
async function resolveExecutors(): Promise<ResolvedExecutors> {
  if (!process.env.OPENAI_API_KEY) {
    const { createWalkthroughExecutors } = await import("./walkthrough-executors");
    return { mode: "walkthrough", executors: createWalkthroughExecutors() };
  }
  const [{ createAiSdkExecutors }, { openai }] = await Promise.all([
    import("@statelyai/agent/ai-sdk"),
    import("@ai-sdk/openai"),
  ]);
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  return {
    mode: "live",
    model,
    executors: createAiSdkExecutors({ resolveModel: () => openai(model) }),
  };
}

/**
 * Runs an example that tells its story across SEVERAL runs (a crash and its
 * recovery, a snapshot resumed on a new machine version). There is no single
 * machine to drive, so the example exports one function and this threads the
 * same observers through it that a single-machine run gets — the transition
 * log, the emits and the refused decisions all read the same either way.
 */
export async function runExampleRunner(
  runner: (options: Record<string, unknown>) => Promise<unknown>,
  limits: RunLimits = {},
): Promise<MachineChatResult> {
  // A runner scripts its own executors; live ones are offered, placeholders
  // are not — the story it tells is deterministic by design.
  const live = process.env.OPENAI_API_KEY ? await resolveExecutors() : null;
  const { trace, onTransition, onEmitted, onTrace } = createTraceRecorder();
  try {
    const output = await runner({
      ...(live ? { executors: live.executors } : {}),
      signal: runSignal(limits),
      onTransition,
      on: { "*": onEmitted },
      onTrace,
      inspect: maybeCreateRunInspection(
        // Multi-run stories re-enter `runAgent` several times; the inspection
        // session spans all of them, so the root keeps one identity.
        { config: {} } as never,
        limits.machineSource,
        "start",
      ),
    });
    return {
      mode: "live",
      ...(live?.model ? { model: live.model } : {}),
      status: "done",
      trace,
      response: renderOutput(output),
      output: smallEventValue(output, false) ?? null,
    };
  } catch (error) {
    return {
      mode: "live",
      status: "error",
      trace,
      response: error instanceof Error ? error.message : String(error),
    };
  }
}

export function hasLiveExecutors(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function startMachineChat(
  machine: AnyStateMachine,
  input: Record<string, unknown>,
  limits: RunLimits = {},
): Promise<MachineChatResult> {
  const live = await resolveExecutors();
  const { trace, onTransition, onEmitted, onTrace, changedKeys, latestContext } =
    createTraceRecorder();
  const result = await runAgent(machine, {
    input: input as never,
    executors: live.executors,
    signal: runSignal(limits),
    onTransition,
    on: { "*": onEmitted },
    onTrace,
    inspect: maybeCreateRunInspection(machine, limits.machineSource, "start"),
  });
  return {
    ...toChatResult(
      machine,
      live.model,
      result as RunAgentResult<AnyStateMachine>,
      trace,
      changedKeys(),
      stringValuesOf(input),
      latestContext(),
      limits,
    ),
    mode: live.mode,
  };
}

/** The string values of an input/event object — user-typed text to not echo. */
function stringValuesOf(source: Record<string, unknown>): string[] {
  return Object.values(source).filter((value): value is string => typeof value === "string");
}

export async function resumeMachineChat(
  machine: AnyStateMachine,
  snapshot: Snapshot<unknown>,
  event: { type: string } & Record<string, unknown>,
  limits: RunLimits = {},
): Promise<MachineChatResult> {
  const live = await resolveExecutors();
  // Baseline: context restored from the snapshot is prior turns' work, not
  // this turn's — only new changes should render as produced output.
  const { trace, onTransition, onEmitted, onTrace, changedKeys, latestContext } =
    createTraceRecorder((snapshot as { context?: unknown }).context);
  // Validate the wire event against the restored snapshot's accepted events
  // (and payload schema, when registered) before delivering it. If the
  // snapshot can't be rehydrated for validation, runAgent still rejects an
  // event the restored state cannot accept.
  let parsed: { type: string } & Record<string, unknown> = event;
  try {
    const restored = machine.resolveState(
      snapshot as never as Parameters<AnyStateMachine["resolveState"]>[0],
    );
    parsed = parseAgentEvent(restored as AnyMachineSnapshot, event, {
      events: machineSchemas(machine).events as never,
    }) as { type: string } & Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes("parseAgentEvent")) throw error;
  }
  const result = await runAgent(machine, {
    snapshot,
    event: parsed as never,
    executors: live.executors,
    signal: runSignal(limits),
    onTransition,
    on: { "*": onEmitted },
    onTrace,
    inspect: maybeCreateRunInspection(machine, limits.machineSource, "resume"),
  });
  return {
    ...toChatResult(
      machine,
      live.model,
      result as RunAgentResult<AnyStateMachine>,
      trace,
      changedKeys(),
      stringValuesOf(parsed),
      latestContext(),
      limits,
    ),
    mode: live.mode,
  };
}
