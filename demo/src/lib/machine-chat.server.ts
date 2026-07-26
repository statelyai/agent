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

/** Collects a run's transitions with real elapsed-time stamps. */
export function createTraceRecorder(): {
  trace: TraceEntry[];
  onTransition: (snapshot: AnyMachineSnapshot, event: unknown) => void;
} {
  const trace: TraceEntry[] = [];
  const startedAt = Date.now();
  return {
    trace,
    onTransition: (snapshot, event) => {
      trace.push({
        at: Date.now() - startedAt,
        event: smallEvent(event),
        value: snapshot.value as Json,
        context: smallContext(snapshot.context),
      });
    },
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
  const direct = (machine as { schemas?: MachineSchemas }).schemas;
  if (direct && typeof direct === "object") return direct;
  const config = (machine as { config?: { schemas?: MachineSchemas } }).config;
  return config?.schemas ?? {};
}

/** Standard Schema / Zod → JSON Schema; null when not derivable. */
export function jsonSchemaOf(schema: unknown): JsonObject | null {
  if (!schema || typeof schema !== "object") return null;
  const standard = (schema as { "~standard"?: { jsonSchema?: { input?: () => unknown } } })["~standard"];
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
};

function interactionHints(snapshot: AnyMachineSnapshot): InteractionHints {
  const meta = getStateMeta(snapshot) as { interaction?: InteractionHints };
  return meta.interaction && typeof meta.interaction === "object" ? meta.interaction : {};
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
      label: hint.label ?? humanizeEventType(descriptor.type),
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

  return {
    prompt: typeof hints.label === "string" ? hints.label : null,
    events,
    textEvent: chosen && field ? { type: chosen.type, field } : null,
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

export type MachineChatResult = {
  mode: "live";
  model?: string;
  status: "done" | "idle" | "error";
  trace: TraceEntry[];
  response: string;
  output?: Json;
  idle?: ChatIdle & { snapshot: Json };
};

/** Output → chat text: strings pass through; single-string objects unwrap; else pretty JSON. */
function renderOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const entries = Object.entries(output as Record<string, unknown>);
    const strings = entries.filter(([, value]) => typeof value === "string");
    if (entries.length === 1 && strings.length === 1) return strings[0][1] as string;
  }
  try {
    return "```json\n" + JSON.stringify(output, null, 2) + "\n```";
  } catch {
    return String(output);
  }
}

function toChatResult(
  machine: AnyStateMachine,
  model: string | undefined,
  result: RunAgentResult<AnyStateMachine>,
  trace: TraceEntry[],
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
    return {
      mode: "live",
      model,
      status: "idle",
      trace,
      response: idle.prompt ?? "The machine is idle, waiting for input.",
      idle: { ...idle, snapshot: persistSnapshot(result.snapshot) as unknown as Json },
    };
  }
  const error = (result as { error?: unknown }).error;
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
  const { trace, onTransition } = createTraceRecorder();
  const result = await runAgent(machine, {
    input: input as never,
    executors: live.executors,
    onTransition,
    inspect: maybeCreateRunInspection(),
  });
  return toChatResult(machine, live.model, result as RunAgentResult<AnyStateMachine>, trace);
}

export async function resumeMachineChat(
  machine: AnyStateMachine,
  snapshot: Snapshot<unknown>,
  event: { type: string } & Record<string, unknown>,
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
  const { trace, onTransition } = createTraceRecorder();
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
    onTransition,
    inspect: maybeCreateRunInspection(),
  });
  return toChatResult(machine, live.model, result as RunAgentResult<AnyStateMachine>, trace);
}
