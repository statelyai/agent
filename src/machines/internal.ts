import type {
  AnyActorRef,
  AnyStateMachine,
  EventObject,
  MachineContext,
  MetaObject,
  StateMachine,
  StateSchema,
  StateValue,
} from "xstate";
import type { AgentTools, StandardSchemaV1 } from "../types.js";

/**
 * The machine type a preset factory returns: its context, event union, input
 * and output are all concrete, so callers get typed `runAgent` input and
 * output instead of `AnyStateMachine`. The remaining slots (children, state
 * value/tags/config, source maps) are left permissive — a preset builds its
 * states dynamically, so there is no literal state schema to infer.
 *
 * @internal
 */
export type PresetMachine<
  TContext extends MachineContext,
  TInput,
  TOutput,
  TEvent extends EventObject = EventObject,
> = StateMachine<
  TContext,
  TEvent,
  Record<string, AnyActorRef | undefined>,
  StateValue,
  string,
  TInput,
  TOutput,
  EventObject,
  MetaObject,
  StateSchema,
  any,
  any,
  any,
  any
>;

/** The builtin inline text request every preset lowers a request entry to. */
export const GENERATE_TEXT_SRC = "agent.generateText";
/** The builtin decision actor the router and supervisor presets invoke. */
export const DECIDE_SRC = "agent.decide";

/**
 * A permissive Standard Schema that carries a JSON Schema. Presets build their
 * own context/input/output schemas this way so the module stays dependency-free
 * (no Zod in `src/`) while `lintAgentMachine` and JSON tooling still see a
 * serializable shape.
 *
 * @internal
 */
export function objectSchema<T>(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): StandardSchemaV1<T> {
  const json = { type: "object", properties, required: [...required] };
  return {
    "~standard": {
      version: 1,
      vendor: "statelyai-agent-machines",
      validate: (value: unknown) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Expected an object" }] };
        }
        const record = value as Record<string, unknown>;
        const issues: Array<{ message: string; path?: PropertyKey[] }> = [];
        for (const key of required) {
          if (!(key in record)) {
            issues.push({ message: `Required property '${key}' is missing`, path: [key] });
          }
        }
        for (const [key, schema] of Object.entries(properties)) {
          const item = record[key];
          if (item === undefined) continue;
          const type = (schema as { type?: unknown } | undefined)?.type;
          const valid =
            type === undefined ||
            (type === "array"
              ? Array.isArray(item)
              : type === "object"
                ? item !== null && typeof item === "object" && !Array.isArray(item)
                : typeof item === type);
          if (!valid) {
            issues.push({ message: `Expected '${key}' to be ${String(type)}`, path: [key] });
          }
        }
        return issues.length > 0 ? { issues } : { value: value as T };
      },
      jsonSchema: { input: () => json },
    },
  } as StandardSchemaV1<T>;
}

/** A payload-less event schema (`{}` shorthand equivalent) with a JSON Schema. @internal */
export const emptyPayload = objectSchema<Record<string, never>>({});

/** JSON Schema fragments reused across preset context schemas. @internal */
export const jsonString = { type: "string" };
/** @internal */
export const jsonNumber = { type: "number" };
/** @internal */
export const jsonRecord = { type: "object", additionalProperties: true };
/** @internal */
export const jsonArray = { type: "array" };
/** @internal */
export const jsonAny = {};

/** One delegated unit of work, lowered to an inline text request. */
export interface PresetRequestEntry {
  /** What this entry is for. Shown to the routing/supervising model. */
  description?: string;
  /** System prompt for this entry's model call. */
  instructions?: string;
  /** Model ref (or `models` alias). Falls back to the factory's `model`. */
  model?: string;
  /** Structured output schema. Omitted means plain text. */
  outputSchema?: StandardSchemaV1;
  /** Tools the host runs inside this one request. */
  tools?: AgentTools;
  /** Bounds the host-side tool loop (lowered to the request's typed `maxSteps`). */
  maxSteps?: number;
}

/** One delegated unit of work, lowered to an invoked child machine. */
export interface PresetMachineEntry {
  /** What this entry is for. Shown to the routing/supervising model. */
  description?: string;
  /** The child machine to invoke. Registered as an actor source, so `runAgent` binds its executors. */
  machine: AnyStateMachine;
  /** Builds the child's `input`. Defaults to `{ prompt }` (`{ message }` for handoff). */
  input?: (args: { prompt: string }) => unknown;
}

/** A route/branch/worker/agent entry: an inline request, or a child machine. */
export type PresetEntry = PresetRequestEntry | PresetMachineEntry;

/** True when `entry` delegates to a child machine rather than an inline request. @internal */
export function isMachineEntry(entry: PresetEntry): entry is PresetMachineEntry {
  return "machine" in entry && !!entry.machine;
}

/** The actor sources a preset must register: one per child-machine entry. @internal */
export function machineActors(
  entries: Record<string, PresetEntry>,
): Record<string, AnyStateMachine> {
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, entry]) => isMachineEntry(entry))
      .map(([name, entry]) => [name, (entry as PresetMachineEntry).machine]),
  );
}

/** The `src` an entry invokes: its own actor key (child machine) or the inline text builtin. @internal */
export function entrySrc(name: string, entry: PresetEntry): string {
  return isMachineEntry(entry) ? name : GENERATE_TEXT_SRC;
}

/** Builds an entry's invoke `input` from the current prompt. @internal */
export function entryInput(
  name: string,
  entry: PresetEntry,
  defaultModel: string | undefined,
  prompt: string,
): unknown {
  if (isMachineEntry(entry)) {
    return entry.input ? entry.input({ prompt }) : { prompt };
  }
  return requestInput(name, entry, defaultModel, prompt);
}

/** Builds the inline `agent.generateText` input for a request entry. @internal */
export function requestInput(
  name: string,
  entry: PresetRequestEntry,
  defaultModel: string | undefined,
  prompt: string,
): Record<string, unknown> {
  const model = entry.model ?? defaultModel;
  if (!model) {
    throw new Error(
      `Preset request '${name}' has no model. Set 'model' on the entry or on the factory config.`,
    );
  }
  return {
    name,
    model,
    ...(entry.instructions ? { system: entry.instructions } : {}),
    prompt,
    ...(entry.tools ? { tools: entry.tools } : {}),
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
    ...(entry.maxSteps !== undefined ? { maxSteps: entry.maxSteps } : {}),
  };
}

/**
 * Rejects an entry name that would collide with a preset's own state names or
 * with the reserved `agent.*` actor namespace. A collision is otherwise a
 * confusing machine-build failure far from its cause.
 *
 * @internal
 */
export function assertEntryNames(
  kind: string,
  names: readonly string[],
  reserved: readonly string[],
): void {
  if (names.length === 0) {
    throw new Error(`Preset requires at least one ${kind}.`);
  }
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `Invalid ${kind} name '${name}'. Names must be identifier-like ` +
          `(letters, digits, underscore; not starting with a digit) — they become ` +
          `state names and event types.`,
      );
    }
    if (reserved.includes(name)) {
      throw new Error(
        `Invalid ${kind} name '${name}': it collides with a state this preset ` +
          `already declares (${reserved.join(", ")}). Rename it.`,
      );
    }
  }
}

/** Renders the `name: description` list a routing/supervising model chooses from. @internal */
export function renderEntryList(entries: Record<string, PresetEntry>): string {
  return Object.entries(entries)
    .map(([name, entry]) => `- ${name}: ${entry.description ?? "(no description)"}`)
    .join("\n");
}
