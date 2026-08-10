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
  persistSnapshot,
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

export type TraceEntry = {
  event: { type: string } & Record<string, Json>;
  value: Json;
  context: Record<string, Json>;
  /** Milliseconds since run start — the client replays with proportional timing. */
  at: number;
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

  return {
    trace,
    onTransition: (snapshot, event) => {
      const type = String((event as { type?: unknown } | null)?.type ?? "");
      observe(snapshot.context, type !== "xstate.init" && type !== "@xstate.init");
      latest = snapshot.context;
      trace.push({
        at: Date.now() - startedAt,
        event: smallEvent(event),
        value: snapshot.value as Json,
        context: smallContext(snapshot.context),
      });
    },
    changedKeys: () =>
      [...changedAt.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key),
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

export function smallEvent(event: unknown): { type: string } & Record<string, Json> {
  if (!event || typeof event !== "object") return { type: String(event) };
  const source = event as Record<string, unknown>;
  const out: { type: string } & Record<string, Json> = { type: String(source.type ?? "event") };
  for (const [key, value] of Object.entries(source)) {
    if (key === "type") continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && value.length <= 60) out[key] = value;
  }
  return out;
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
  label?: string;
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
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = source[key];
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
  const nodes = (snapshot as { _nodes?: Array<{ description?: string }> })._nodes ?? [];
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
  const rawPrompt = typeof hints.label === "string" ? hints.label : activeDescription(snapshot);

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
  /**
   * Human-wait state tag from metadata `suspendedTag` — deterministic idle
   * for plain XState machines with no setupAgent isSuspended predicate.
   */
  suspendedTag?: string;
};

export const DEFAULT_RUN_BUDGET_MS = 120_000;

/** metadata `suspendedTag` → an isSuspended predicate, or undefined. */
function suspendedPredicate(
  limits: RunLimits,
): ((snapshot: AnyMachineSnapshot) => boolean) | undefined {
  const tag = limits.suspendedTag;
  return tag ? (snapshot) => snapshot.hasTag(tag) : undefined;
}

/** One signal for runAgent: request abort OR time budget, whichever first. */
export function runSignal(limits: RunLimits): AbortSignal {
  const budget = AbortSignal.timeout(limits.budgetMs ?? DEFAULT_RUN_BUDGET_MS);
  return limits.signal ? AbortSignal.any([limits.signal, budget]) : budget;
}

export type MachineChatResult = {
  mode: "live";
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
      const [bodyKey, body] = strings.reduce((longest, entry) =>
        entry[1].length > longest[1].length ? entry : longest,
      );
      const rest = entries.filter(
        ([key, value]) =>
          key !== bodyKey &&
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
      );
      if (!rest.length) return body;
      const list = rest.map(([key, value]) => `${humanizeFieldName(key)}: ${String(value)}`);
      return `${body}\n\n${list.join("\n")}`;
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
 * (`omitValues`) and message-history arrays are plumbing, not work — skipped.
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
    value.every(
      (item) => item && typeof item === "object" && "role" in item && "content" in item,
    );

  const strings: Array<{ key: string; body: string }> = [];
  const objects: Array<{ key: string; body: string }> = [];
  for (const key of changedKeys) {
    const value = source[key];
    if (isMessageHistory(value)) continue;
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
    return {
      mode: "live",
      model,
      status: "idle",
      trace,
      response: work ?? idle.prompt ?? "The machine is idle, waiting for input.",
      // Resume from the run's persisted snapshot, not the live one — it
      // round-trips invoked children WITH their state (a long-lived agent
      // keeps its context across chat turns).
      idle: { ...idle, snapshot: persistSnapshot(result.persistedSnapshot) as unknown as Json },
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

/** Live AI SDK executors that resolve EVERY model ref to one OpenAI model. */
async function liveExecutors(): Promise<{
  model: string;
  executors: Partial<AgentRequestExecutors>;
} | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const [{ createAiSdkExecutors }, { openai }] = await Promise.all([
    import("@statelyai/agent/ai-sdk"),
    import("@ai-sdk/openai"),
  ]);
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  return { model, executors: createAiSdkExecutors({ resolveModel: () => openai(model) }) };
}

export function hasLiveExecutors(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function startMachineChat(
  machine: AnyStateMachine,
  input: Record<string, unknown>,
  limits: RunLimits = {},
): Promise<MachineChatResult> {
  const live = await liveExecutors();
  if (!live) {
    return {
      mode: "live",
      status: "error",
      trace: [],
      response: "Running library examples needs OPENAI_API_KEY set for the demo server.",
    };
  }
  const { trace, onTransition, changedKeys, latestContext } = createTraceRecorder();
  const result = await runAgent(machine, {
    input: input as never,
    executors: live.executors,
    signal: runSignal(limits),
    isSuspended: suspendedPredicate(limits),
    onTransition,
    inspect: maybeCreateRunInspection(machine),
  });
  return toChatResult(
    machine,
    live.model,
    result as RunAgentResult<AnyStateMachine>,
    trace,
    changedKeys(),
    stringValuesOf(input),
    latestContext(),
    limits,
  );
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
  const live = await liveExecutors();
  if (!live) {
    return {
      mode: "live",
      status: "error",
      trace: [],
      response: "Running library examples needs OPENAI_API_KEY set for the demo server.",
    };
  }
  // Baseline: context restored from the snapshot is prior turns' work, not
  // this turn's — only new changes should render as produced output.
  const { trace, onTransition, changedKeys, latestContext } = createTraceRecorder(
    (snapshot as { context?: unknown }).context,
  );
  // Validate the wire event against the restored snapshot's accepted events
  // (and payload schema, when registered) before delivering it. If the
  // snapshot can't be rehydrated for validation, runAgent's own
  // onIllegalResumeEvent guard still rejects illegal event types.
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
    isSuspended: suspendedPredicate(limits),
    onTransition,
    inspect: maybeCreateRunInspection(machine),
  });
  return toChatResult(
    machine,
    live.model,
    result as RunAgentResult<AnyStateMachine>,
    trace,
    changedKeys(),
    stringValuesOf(parsed),
    latestContext(),
    limits,
  );
}
