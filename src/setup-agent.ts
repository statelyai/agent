import {
  setup,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type AnySetupConfig,
  type AsyncActorLogic,
  type EventObject,
  type MachineContext,
  type MetaObject,
  type NonReducibleUnknown,
  type SetupReturnFromConfig,
  type SetupStateSchema,
} from "xstate";
import type {
  AgentEventSchemaInputMap,
  AgentMessage,
  EventUnion,
  InferInput,
  InferOutput,
  NormalizedEventSchemas,
  StandardSchemaV1,
  WithAgentInputSchema,
} from "./types.js";
import {
  builtinTextActors,
  createTextLogic,
  userInputActor,
  DECIDE_ACTOR,
  USER_INPUT_ACTOR,
  type AgentModelMap,
  type AgentModelRef,
  type BuiltinAgentActors,
  type TextLogic,
  type TextLogicConfig,
} from "./text-logic.js";
import { createDecideActor } from "./decision.js";
import { AGENT_USAGE_EVENT_TYPE, type AgentUsageEvent } from "./effects.js";
import { appendMessages } from "./messages.js";
import { agentExecutionOptions, machineIdlePredicates } from "./internal/registry.js";
import type { AgentSchemas } from "./events.js";
import {
  setupAgentFromConfig,
  type AgentWorkflowConfig,
  type FromConfigOptions,
  type FromConfigResult,
} from "./workflow-config.js";

// ─── setupAgent ───

// Narrows T to TConstraint, falling back to TConstraint itself when T doesn't already satisfy it (keeps xstate's setup() constraints happy).
type Constrain<T, TConstraint> = T extends TConstraint ? T : TConstraint;

// A context schema's validated output type, constrained to MachineContext.
type ContextOf<TContextSchema extends StandardSchemaV1> = Constrain<
  InferOutput<TContextSchema>,
  MachineContext
>;
// An event schema map's discriminated event union, constrained to EventObject.
type EventsOf<TEventSchemas extends AgentEventSchemaInputMap> = Constrain<
  EventUnion<TEventSchemas>,
  EventObject
>;
// Identity mapping over an actor map, preserving each entry's AsyncActorLogic input/output types.
type SetupActors<TActors extends { [K in keyof TActors]: AnyActorLogic }> = {
  [K in keyof TActors]: TActors[K] extends AsyncActorLogic<infer TOutput, infer TInput>
    ? AsyncActorLogic<TOutput, TInput>
    : TActors[K];
};
type AgentSetupActors<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TEvent extends string = string,
  TModel extends string = string,
> = TActors & BuiltinAgentActors<TEvent, TModel>;

/**
 * A machine's full schema set — context, event payloads, machine input/
 * output, and state/transition meta — as returned by {@link createAgentSchemas}
 * and retained on `setupAgent(...)`'s `result.schemas` for runtime
 * validation (e.g. by the step path to validate `initialAgentStep` input, or
 * by `getAcceptedEvents` to attach event payload schemas). Unlike
 * `AgentSchemaConfig` (the input to `createAgentSchemas`), every field here
 * is required — `events`/`input`/`output`/`meta` default to empty/unknown
 * schemas when not supplied.
 */
export interface AgentSchemaPack<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>> = StandardSchemaV1<
    Record<string, unknown>
  >,
  TEventSchemas extends AgentEventSchemaInputMap = AgentEventSchemaInputMap,
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetaSchema extends StandardSchemaV1 = StandardSchemaV1<MetaObject>,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = Record<string, StandardSchemaV1>,
> {
  context: TContextSchema;
  events: NormalizedEventSchemas<TEventSchemas>;
  input: TInputSchema;
  output: TOutputSchema;
  meta: TMetaSchema;
  /** Schemas for events the machine emits (`enq.emit(...)`), keyed by event type — they type `enq.emit` in the machine and the `on` handlers of {@link runAgent}. Optional: omitted means emitted events stay untyped. */
  emitted?: TEmittedSchemas;
}

// Input to createAgentSchemas: only `context` is required, everything else defaults.
type AgentSchemaConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = Record<string, StandardSchemaV1>,
> = {
  context: TContextSchema;
  events?: TEventSchemas;
  input?: TInputSchema;
  output?: TOutputSchema;
  meta?: TMetaSchema;
  emitted?: TEmittedSchemas;
};

const emptyEventSchema: StandardSchemaV1<Record<string, never>> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      return value !== null && typeof value === "object" && Object.keys(value).length === 0
        ? { value: {} }
        : { issues: [{ message: "Expected an empty event payload" }] };
    },
  },
};

/**
 * The payload of the reserved `'@agent.usage'` event — {@link AgentUsageEvent}
 * without its `type`. It is what a machine's `'@agent.usage'` handler receives
 * alongside `type`, since event schemas describe payloads only.
 */
export type AgentUsageEventPayload = Omit<AgentUsageEvent, "type">;

const USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const;
const USAGE_ATTRIBUTION_FIELDS = ["id", "src", "model", "name"] as const;
const USAGE_KINDS = ["text", "decision"] as const;

/**
 * Standard Schema for the reserved `'@agent.usage'` payload. Hand-rolled (no
 * validation-library dependency in core) and deliberately permissive about
 * unknown fields, so a newer runtime adding an attribution field cannot fail
 * an older machine's validation.
 */
const agentUsageEventSchema: StandardSchemaV1<AgentUsageEventPayload> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      const issues: Array<{ message: string; path?: unknown[] }> = [];
      if (!value || typeof value !== "object") {
        return { issues: [{ message: "Expected an '@agent.usage' payload object" }] };
      }
      const event = value as Record<string, unknown>;
      const usage = event.usage;
      if (!usage || typeof usage !== "object") {
        issues.push({ message: "Expected 'usage' to be an object", path: ["usage"] });
      } else {
        for (const field of USAGE_TOKEN_FIELDS) {
          const token = (usage as Record<string, unknown>)[field];
          if (token !== undefined && (typeof token !== "number" || !Number.isFinite(token))) {
            issues.push({ message: `Expected a finite number`, path: ["usage", field] });
          }
        }
      }
      if (event.kind !== undefined && !USAGE_KINDS.some((kind) => kind === event.kind)) {
        issues.push({ message: `Expected one of ${USAGE_KINDS.join(", ")}`, path: ["kind"] });
      }
      for (const field of USAGE_ATTRIBUTION_FIELDS) {
        if (event[field] !== undefined && typeof event[field] !== "string") {
          issues.push({ message: "Expected a string", path: [field] });
        }
      }
      return issues.length > 0 ? { issues } : { value: event as AgentUsageEventPayload };
    },
  },
};

/**
 * An authored event schema map with the reserved `'@agent.usage'` entry added —
 * every agent machine's event union includes it, so `on: { '@agent.usage': … }`
 * is typed (and autocompletes) without the machine declaring anything.
 * Idempotent: re-applying it to an already-registered map is a no-op.
 */
export type WithAgentUsageEvent<T extends AgentEventSchemaInputMap> = Omit<
  T,
  typeof AGENT_USAGE_EVENT_TYPE
> & {
  [AGENT_USAGE_EVENT_TYPE]: StandardSchemaV1<AgentUsageEventPayload>;
};

/**
 * Adds the reserved `'@agent.usage'` schema to an authored event map. A
 * user-declared entry under that key is rejected: the `@agent.*` namespace
 * belongs to the library (same rule as the reserved `agent.*` actor keys), and
 * a custom payload schema would silently disagree with what `runAgent`
 * delivers.
 */
function withAgentUsageEventSchema<T extends AgentEventSchemaInputMap>(
  events: T | undefined,
): WithAgentUsageEvent<T> {
  const declared = events?.[AGENT_USAGE_EVENT_TYPE];
  if (declared !== undefined && declared !== agentUsageEventSchema) {
    throw new Error(
      `setupAgent: event type '${AGENT_USAGE_EVENT_TYPE}' is in the reserved '@agent.' ` +
        `namespace and cannot be declared in 'events' — setupAgent registers it for you with ` +
        `the usage payload schema. Remove it from 'events'; to receive it, declare a ` +
        `transition instead: on: { '${AGENT_USAGE_EVENT_TYPE}': … }.`,
    );
  }
  return {
    ...events,
    [AGENT_USAGE_EVENT_TYPE]: agentUsageEventSchema,
  } as WithAgentUsageEvent<T>;
}

function normalizeEventSchemas<T extends AgentEventSchemaInputMap>(
  events: T,
): NormalizedEventSchemas<T> {
  return Object.fromEntries(
    Object.entries(events).map(([type, schema]) => [
      type,
      schema && typeof schema === "object" && "~standard" in schema ? schema : emptyEventSchema,
    ]),
  ) as NormalizedEventSchemas<T>;
}

/**
 * Builds a machine's {@link AgentSchemaPack} from a partial schema
 * declaration — only `context` is required; `events`/`input`/`output`/`meta`
 * default to empty/unknown schemas when omitted. Pass the result as
 * `setupAgent({ schemas })`'s `schemas` (or spread the individual fields
 * directly into `setupAgent({ context, events, ... })` — both forms are
 * accepted).
 */
export function createAgentSchemas<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap = {},
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetaSchema extends StandardSchemaV1 = StandardSchemaV1<MetaObject>,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = {},
>(
  schemas: AgentSchemaConfig<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TEmittedSchemas
  >,
): AgentSchemaPack<
  TContextSchema,
  WithAgentUsageEvent<TEventSchemas>,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TEmittedSchemas
> {
  return {
    context: schemas.context,
    events: normalizeEventSchemas(
      withAgentUsageEventSchema(schemas.events),
    ) as NormalizedEventSchemas<WithAgentUsageEvent<TEventSchemas>>,
    input: schemas.input as TInputSchema,
    output: schemas.output as TOutputSchema,
    meta: schemas.meta as TMetaSchema,
    emitted: schemas.emitted as TEmittedSchemas,
  };
}

// Maps request keys to their input/output schema pair — the shape `setupAgent({ requests })` and `AgentRequestInput` are keyed by.
//
// This indirection looks removable (why not infer the request map directly
// from the config?) but is load-bearing: `AgentRequestInput` anchors inference
// on `schemas: TRequestSchemas[K]`, which is what gives the `({ input }) =>`
// resolvers (`prompt`, `system`, `model`, …) their parameter types. Inferring
// a `Record<string, TextLogicConfig>` straight from the literal instead
// makes every resolver's `input` an implicit `any`.
export type AgentRequestSchemaMap = Record<
  string,
  {
    input?: StandardSchemaV1;
    output?: StandardSchemaV1;
  }
>;

// Resolves a request entry's (optional) schema slot to the declared schema, or
// to `TFallback` when the entry omits it. Reads the slot by INDEXED ACCESS
// (`TRequestSchemas[K]["output"]`) rather than by `extends { output?: infer S }`:
// the entry types here come from reverse-mapped-type inference on the
// `requests` literal, and a shape test against one of those resolves as if the
// omitted-in-some-entries slot were absent everywhere (every request then types
// as the fallback). Tuples keep an optional slot (`Schema | undefined`) from
// distributing into a union of "the schema" and "the fallback".
type ResolvedRequestSchema<TSchema, TFallback> = [NonNullable<TSchema>] extends [never]
  ? TFallback
  : [NonNullable<TSchema>] extends [StandardSchemaV1]
    ? NonNullable<TSchema>
    : TFallback;

// A request entry's input schema, defaulting to the no-input schema (the
// request takes no invoke `input`) when the entry declares none.
type RequestInputSchema<TSchemas extends { input?: StandardSchemaV1 }> = ResolvedRequestSchema<
  TSchemas["input"],
  StandardSchemaV1<undefined>
>;

// A request entry's output schema, defaulting to a string schema (a plain
// text request) when the entry declares none.
type RequestOutputSchema<TSchemas extends { output?: StandardSchemaV1 }> = ResolvedRequestSchema<
  TSchemas["output"],
  StandardSchemaV1<string>
>;

// The full `setupAgent({ requests })` map: one entry per schema-map entry, each
// carrying its own schemas. An entry's config is identical to a standalone
// `createTextLogic(...)` config (`mode` included): a request entry lowers to
// exactly that, with `name` defaulted from the map key.
export type AgentRequestInput<
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
> = {
  [K in keyof TRequestSchemas]: Omit<
    TextLogicConfig<
      RequestInputSchema<TRequestSchemas[K]>,
      RequestOutputSchema<TRequestSchemas[K]>,
      Record<string, unknown>,
      TModel
    >,
    "schemas"
  > & {
    // Required (even when empty: `schemas: {}`), unlike a standalone
    // `createTextLogic` config's optional `schemas`. An entry that omits the
    // key entirely defeats the reverse-mapped-type inference this map relies
    // on, silently typing EVERY request's input/output as `unknown`; keeping
    // it required turns that into a compile error instead.
    schemas: TRequestSchemas[K];
  };
};

// The TextLogic actors createRequestActors builds from an AgentRequestInput — one per request key.
type RequestActors<TRequestSchemas extends AgentRequestSchemaMap> = {
  [K in keyof TRequestSchemas]: TextLogic<
    RequestInputSchema<TRequestSchemas[K]>,
    RequestOutputSchema<TRequestSchemas[K]>
  >;
};

// User-declared `actors` merged with the TextLogic actors generated from `requests`.
type AgentAllActors<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
> = TActors & RequestActors<TRequestSchemas>;

// The `events` schemas handed to xstate's setup: the machine's declared events
// PLUS the reserved `'@agent.usage'` entry, which every agent machine gets by
// default so its handler is typed without being declared. The map is therefore
// never empty — which also sidesteps the xstate-alpha behavior where a
// present-but-empty `events: {}` makes `InferEvents<{}>` → `never`, setting the
// machine's `TEvent` (and, cascading, its `context`) to `never`.
type AgentSetupEventsSchema<TEventSchemas extends AgentEventSchemaInputMap> = {
  events: NormalizedEventSchemas<WithAgentUsageEvent<TEventSchemas>>;
};

// Same omit-when-empty routing as AgentSetupEventsSchema, for `emitted`
// schemas: only a non-empty declared map reaches xstate's setup schemas, so
// an agent that emits nothing keeps xstate's AnyEventObject default.
type AgentSetupEmittedSchema<TEmittedSchemas extends Record<string, StandardSchemaV1>> = [
  keyof TEmittedSchemas,
] extends [never]
  ? {}
  : { emitted: TEmittedSchemas };

// NOTE: this is a *plain object* config type, NOT `SetupConfig<...>`.
//
// `SetupConfig<TSchemas, ...>` declares `schemas?: TSchemas & SetupSchemas`.
// When `TSchemas.events` (a concrete `{ GO: … }` map) is intersected with
// `SetupSchemas['events']` (`Record<string, StandardSchemaV1> | undefined`),
// the event map gains a string index signature (`{ GO: … } & Record<string,
// StandardSchemaV1>`). xstate's `InferEvents` has a `string extends keyof O`
// branch that then collapses every event to bare `{ type: K }`, discarding
// the schema-derived payload. Feeding `SetupReturnFromConfig` a plain object
// (no `& SetupSchemas` intersection) keeps `keyof events` as the literal key
// union, so payloads survive and `on:` transition fns narrow correctly.
// (Repro: a state's `({ event }) => event.n` lost `n` under the old alias.)
/**
 * The input schema as handed to xstate's `setup(...)`, with the machine's input
 * type branded by the schema it came from.
 *
 * XState resolves `schemas.input` to a single type used both by
 * `createActor`'s `input` option and by the `context: ({ input })` factory —
 * and it never validates, so a schema default reads as a required field at the
 * call site while being absent at runtime. `runAgent` validates the input
 * (filling defaults) and reads this brand back through `AgentInputFrom` to
 * accept the schema's looser *input* side, while the factory keeps seeing the
 * validated *output* side.
 *
 * Only object-shaped input is branded: with no declared input schema the
 * resolved type is xstate's `NonReducibleUnknown` (a union including `null`),
 * and intersecting a brand into that collapses members to `never`.
 */
type BrandedInputSchema<TInputSchema extends StandardSchemaV1> =
  InferOutput<TInputSchema> extends Record<string, unknown>
    ? StandardSchemaV1<
        InferInput<TInputSchema>,
        InferOutput<TInputSchema> & WithAgentInputSchema<TInputSchema>
      >
    : TInputSchema;

type AgentSetupXStateConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = {},
  TStateSchemas extends Record<string, SetupStateSchema> = Record<string, SetupStateSchema>,
> = {
  schemas: {
    context: TContextSchema;
    input: BrandedInputSchema<TInputSchema>;
    output: TOutputSchema;
    meta: TMetaSchema;
  } & AgentSetupEventsSchema<TEventSchemas> &
    AgentSetupEmittedSchema<TEmittedSchemas>;
  // Per-state schemas (xstate `setup({ states })`): narrows `context` inside
  // the declared states (invoke inputs, transition fns, final outputs).
  states?: TStateSchemas;
  actors: SetupActors<
    AgentSetupActors<
      AgentAllActors<TActors, TRequestSchemas>,
      // Reserved `@agent.*` types are never model-facing, so they stay out of
      // the `allowedEvents` candidate union the decide builtin types.
      Exclude<keyof TEventSchemas & string, typeof AGENT_USAGE_EVENT_TYPE>,
      AgentModelRef<TModels>
    >
  >;
  actions?: NonNullable<AnySetupConfig["actions"]>;
  guards?: NonNullable<AnySetupConfig["guards"]>;
  delays?: NonNullable<AnySetupConfig["delays"]>;
};

// ─── per-state context narrowing ───

/**
 * Field-level context-narrowing sugar for one `setupAgent({ states })` entry:
 * each `context` entry overrides that field's schema inside the state; every
 * other field keeps the base context schema. Sugar for the full xstate form —
 * `{ context: { draft: z.string() } }` resolves to
 * `{ schemas: { context: <base with draft: string> } }` — so only the fields
 * that change are declared, not the whole context schema.
 */
export interface AgentStateNarrowing {
  context: Record<string, StandardSchemaV1>;
  states?: Record<string, AgentSetupStateSchema>;
}

/** One `setupAgent({ states })` entry: xstate's {@link SetupStateSchema} full form, or the {@link AgentStateNarrowing} field-level sugar. */
export type AgentSetupStateSchema = SetupStateSchema | AgentStateNarrowing;

// The narrowed context type for a state: base context with the declared fields' schemas swapped in.
type NarrowedContext<
  TContextSchema extends StandardSchemaV1,
  TFields extends Record<string, StandardSchemaV1>,
> = Omit<InferOutput<TContextSchema>, keyof TFields> & {
  [K in keyof TFields]: InferOutput<TFields[K]>;
};

// Resolves one AgentSetupStateSchema into xstate's SetupStateSchema shape (recursing into nested states).
type ResolveAgentStateSchema<TContextSchema extends StandardSchemaV1, T> = T extends {
  context: infer TFields extends Record<string, StandardSchemaV1>;
}
  ? {
      schemas: {
        context: StandardSchemaV1<NarrowedContext<TContextSchema, TFields>>;
      };
    } & (T extends { states: infer TChildren extends Record<string, AgentSetupStateSchema> }
      ? { states: ResolveAgentStateSchemas<TContextSchema, TChildren> }
      : {})
  : T extends { states: infer TChildren extends Record<string, AgentSetupStateSchema> }
    ? Omit<T, "states"> & { states: ResolveAgentStateSchemas<TContextSchema, TChildren> }
    : T;

// Resolves a whole `setupAgent({ states })` map into xstate's Record<string, SetupStateSchema>.
type ResolveAgentStateSchemas<
  TContextSchema extends StandardSchemaV1,
  TStates extends Record<string, AgentSetupStateSchema>,
> = Constrain<
  {
    [K in keyof TStates]: ResolveAgentStateSchema<TContextSchema, TStates[K]>;
  },
  Record<string, SetupStateSchema>
>;

// Composite standard schema for a narrowed state context: validates against the
// base context schema, then re-validates each overridden field. Purely a type/
// validation carrier for xstate's setup({ states }) — no zod dependency.
function mergeContextSchema(
  base: StandardSchemaV1,
  fields: Record<string, StandardSchemaV1>,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "statelyai-agent",
      validate(value: unknown) {
        const baseResult = base["~standard"].validate(value);
        if (baseResult instanceof Promise) {
          throw new Error("setupAgent: async context schemas are not supported.");
        }
        if (baseResult.issues) {
          return baseResult;
        }
        const merged: Record<string, unknown> = {
          ...(baseResult.value as Record<string, unknown>),
        };
        const issues: Array<{ message: string; path?: unknown[] }> = [];
        for (const [key, fieldSchema] of Object.entries(fields)) {
          const fieldResult = fieldSchema["~standard"].validate(
            (value as Record<string, unknown>)[key],
          );
          if (fieldResult instanceof Promise) {
            throw new Error("setupAgent: async context schemas are not supported.");
          }
          if (fieldResult.issues) {
            issues.push(
              ...(fieldResult.issues as Array<{ message: string; path?: unknown[] }>).map(
                (issue) => ({
                  ...issue,
                  path: [key, ...(issue.path ?? [])],
                }),
              ),
            );
          } else {
            merged[key] = fieldResult.value;
          }
        }
        return issues.length > 0 ? { issues } : { value: merged };
      },
    },
  } as StandardSchemaV1;
}

// Resolves the AgentStateNarrowing sugar in a `states` map to xstate's SetupStateSchema shape at runtime (the type-level counterpart is ResolveAgentStateSchemas).
function resolveAgentStateSchemas(
  contextSchema: StandardSchemaV1,
  states: Record<string, AgentSetupStateSchema>,
): Record<string, SetupStateSchema> {
  return Object.fromEntries(
    Object.entries(states).map(([key, state]) => {
      if (!state || typeof state !== "object") {
        return [key, state];
      }
      const children =
        "states" in state && state.states
          ? resolveAgentStateSchemas(contextSchema, state.states)
          : undefined;
      if ("context" in state && state.context) {
        return [
          key,
          {
            schemas: { context: mergeContextSchema(contextSchema, state.context) },
            ...(children ? { states: children } : {}),
          },
        ];
      }
      return [key, children ? { ...state, states: children } : state];
    }),
  );
}

// The public `setupAgent(config)` parameter type: schemas (packed or loose) plus models/actors/requests/actions/guards/delays.
type SetupAgentBaseConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TRequestSchemas extends AgentRequestSchemaMap,
  TModels extends AgentModelMap,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = {},
  TStateSchemas extends Record<string, AgentSetupStateSchema> = Record<
    string,
    AgentSetupStateSchema
  >,
> = (
  | {
      schemas: AgentSchemaPack<
        TContextSchema,
        TEventSchemas,
        TInputSchema,
        TOutputSchema,
        TMetaSchema,
        TEmittedSchemas
      >;
    }
  | AgentSchemaConfig<
      TContextSchema,
      TEventSchemas,
      TInputSchema,
      TOutputSchema,
      TMetaSchema,
      TEmittedSchemas
    >
) & {
  models?: TModels;
  actors?: TActors;
  /**
   * Per-state schemas, mirroring xstate's `setup({ states })`: narrow
   * `context` inside a state (invoke `input`, transition fns, final `output`)
   * — e.g. mark a field non-null in states only reachable after it is set.
   * Two forms per state: the {@link AgentStateNarrowing} sugar
   * (`{ context: { draft: z.string() } }` — only the fields that change) or
   * xstate's full `{ schemas: { context } }` with a complete context schema.
   */
  states?: TStateSchemas;
  requests?: AgentRequestInput<TRequestSchemas, AgentModelRef<TModels>>;
  actions?: NonNullable<AnySetupConfig["actions"]>;
  guards?: NonNullable<AnySetupConfig["guards"]>;
  delays?: NonNullable<AnySetupConfig["delays"]>;
  /**
   * Detects a snapshot that is an INTENTIONAL wait for an external event (a
   * human approval, an inbound webhook, …) — the machine's own declaration of
   * what "idle" means for it, so `runAgent` settles those snapshots idle
   * deterministically instead of using its timing heuristic. Travels with the
   * machine through `machine.provide(...)`. A `runAgent({ isIdle })` host
   * override takes precedence; with neither, `runAgent` falls back to the timing
   * heuristic. Declare your own signal — e.g. `(s) => s.hasTag('awaiting-review')`
   * or `(s) => getStateMeta(s).interaction !== undefined`.
   */
  isIdle?: (snapshot: AnyMachineSnapshot) => boolean;
};

// The raw xstate `setup(...)` result type for an agent config, before setupAgent's own extensions (schemas/models/requests/appendMessages, plus the wrapped createMachine) are added.
type SetupAgentXStateResult<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = {},
  TStateSchemas extends Record<string, AgentSetupStateSchema> = Record<
    string,
    AgentSetupStateSchema
  >,
> = SetupReturnFromConfig<
  AgentSetupXStateConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels,
    TEmittedSchemas,
    ResolveAgentStateSchemas<TContextSchema, TStateSchemas>
  >
>;

/**
 * The object returned by {@link setupAgent}: an xstate `setup(...)` result
 * (`createMachine`, `assign`, …) extended with `schemas` (the resolved
 * {@link AgentSchemaPack}), `models`, `requests` (the built request actors),
 * and {@link appendMessages}. Machines created here are registered so
 * `runAgent` and the free step helpers can resolve their schemas/actors
 * without re-passing them each call.
 */
type SetupAgentResult<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = {},
  TStateSchemas extends Record<string, AgentSetupStateSchema> = Record<
    string,
    AgentSetupStateSchema
  >,
> = Omit<
  SetupAgentXStateResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels,
    TEmittedSchemas,
    TStateSchemas
  >,
  "createMachine"
> & {
  /**
   * Creates the agent machine — XState's own `createMachine`, plus: the
   * machine is registered so step helpers and {@link runAgent} can resolve
   * its schemas/actors without re-passing them, and a single final state's
   * `output` is copied to the machine root when the root declares none.
   */
  createMachine: SetupAgentXStateResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels,
    TEmittedSchemas,
    TStateSchemas
  >["createMachine"];
  /** The retained schema pack ({@link AgentSchemaPack}) for host-side validation and tooling. Its `events` include the reserved `'@agent.usage'` entry setupAgent registers by default. */
  schemas: AgentSchemaPack<
    TContextSchema,
    WithAgentUsageEvent<TEventSchemas>,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TEmittedSchemas
  >;
  /** The `models` registry passed to `setupAgent(...)`, if any (used to type-narrow `AgentModelRef`). */
  readonly models: TModels;
  /** The {@link TextLogic} actors built from `setupAgent({ requests })`, keyed the same way. */
  readonly requests: RequestActors<TRequestSchemas>;
  /** {@link appendMessages}, typed against this agent's context/event schemas. */
  appendMessages(
    resolve:
      | AgentMessage
      | AgentMessage[]
      | ((args: {
          context: ContextOf<TContextSchema> & { messages: AgentMessage[] };
          event: any;
        }) => AgentMessage | AgentMessage[]),
  ): ReturnType<
    typeof appendMessages<
      ContextOf<TContextSchema> & { messages: AgentMessage[] },
      EventsOf<WithAgentUsageEvent<TEventSchemas>>
    >
  >;
};

/**
 * Schema-first `setup(...)` for agent machines — the standard entry point
 * for authoring a machine (the blueprint) that this library then runs (via
 * {@link runAgent} or the step helpers) against host-supplied model/decision
 * executors. Context, events, machine input, machine output, and
 * state/transition meta are all standard schemas — no `{} as Type` casts —
 * and are retained on `result.schemas` for runtime validation. Also
 * registers the `agent.generateText`/`agent.streamText`/`agent.userInput`/
 * `agent.decide` builtin actors and lowers `requests`/`actors` into the
 * machine's actor sources. The result is the xstate `setup(...)` object with
 * a wrapped `result.createMachine(...)` plus `result.schemas`/`models`/
 * `requests`/`appendMessages` attached. Also has a
 * `setupAgent.fromConfig(...)` namespace member for building a machine from
 * a serializable {@link AgentWorkflowConfig} instead of this TS API.
 *
 * @example
 * ```ts
 * const schemas = createAgentSchemas({
 *   context: z.object({ topic: z.string(), joke: z.string().nullable() }),
 *   input: z.object({ topic: z.string() }),
 *   output: z.object({ joke: z.string() }),
 * });
 *
 * const agent = setupAgent({
 *   schemas,
 *   actors: { tellJoke },
 * });
 *
 * const jokeMachine = agent.createMachine({
 *   context: ({ input }) => ({ topic: input.topic, joke: null }),
 *   initial: 'telling',
 *   states: {
 *     telling: {
 *       invoke: {
 *         id: 'joke',
 *         src: 'tellJoke',
 *         input: ({ context }) => ({ topic: context.topic }),
 *         onDone: ({ output }) => ({ target: 'done', context: { joke: output } }),
 *       },
 *     },
 *     done: { type: 'final', output: ({ context }) => ({ joke: context.joke ?? '' }) },
 *   },
 * });
 * ```
 */
export function setupAgent<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap = {},
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetaSchema extends StandardSchemaV1 = StandardSchemaV1<MetaObject>,
  TModels extends AgentModelMap = {},
  TEmittedSchemas extends Record<string, StandardSchemaV1> = {},
  const TStateSchemas extends Record<string, AgentSetupStateSchema> = Record<
    string,
    AgentSetupStateSchema
  >,
>(
  config: SetupAgentBaseConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TRequestSchemas,
    TModels,
    TEmittedSchemas,
    TStateSchemas
  >,
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TModels,
  TEmittedSchemas,
  TStateSchemas
> {
  const schemas = normalizeAgentSchemas<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TEmittedSchemas
  >(config);
  // `requests` is optional; an omitted map is simply empty.
  const requests = (config.requests ?? {}) as AgentRequestInput<
    TRequestSchemas,
    AgentModelRef<TModels>
  >;
  const requestActors = createRequestActors<TRequestSchemas, AgentModelRef<TModels>>(requests);
  const actors = createAgentActors<TActors, TRequestSchemas, AgentModelRef<TModels>>(
    config.actors,
    requestActors,
  );
  // The plain-object config passed to xstate's setup(...) (see
  // AgentSetupXStateConfig's note on why it's not SetupConfig<...>).
  const setupConfig: AgentSetupXStateConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels,
    TEmittedSchemas,
    ResolveAgentStateSchemas<TContextSchema, TStateSchemas>
  > = {
    schemas: {
      context: schemas.context,
      events: schemas.events,
      input: schemas.input,
      output: schemas.output,
      meta: schemas.meta,
      // Runtime pass-through mirrors AgentSetupEmittedSchema: only a
      // non-empty declared map reaches xstate's setup schemas.
      ...(schemas.emitted && Object.keys(schemas.emitted).length > 0
        ? { emitted: schemas.emitted }
        : {}),
      // The conditional AgentSetup*Schema keys can't be proven from a spread.
    } as AgentSetupXStateConfig<
      TContextSchema,
      TEventSchemas,
      TActors,
      TRequestSchemas,
      TInputSchema,
      TOutputSchema,
      TMetaSchema,
      TModels,
      TEmittedSchemas,
      ResolveAgentStateSchemas<TContextSchema, TStateSchemas>
    >["schemas"],
    // Resolve the AgentStateNarrowing sugar into xstate's full per-state
    // schema form (the cast mirrors the type-level ResolveAgentStateSchemas).
    ...(config.states
      ? {
          states: resolveAgentStateSchemas(
            schemas.context,
            config.states,
          ) as ResolveAgentStateSchemas<TContextSchema, TStateSchemas>,
        }
      : {}),
    // `createAgentActors` builds with a widened `string` event union; the setup
    // config narrows it to the declared (non-reserved) event types.
    actors: actors as never,
    actions: config.actions,
    guards: config.guards,
    delays: config.delays,
  };
  const base = setup(setupConfig);
  const createBaseMachine = base.createMachine.bind(base);
  const models = (config.models ?? {}) as TModels;
  const machineOptions = {
    schemas,
    actors,
    models,
  };

  return Object.assign(base, {
    createMachine(machineConfig: Parameters<typeof base.createMachine>[0]) {
      assertStateSchemaKeysExist(
        config.states,
        (machineConfig as { states?: Record<string, any> } | undefined)?.states,
      );
      const machine = createBaseMachine(withRootOutputFromSingleFinal(machineConfig) as never);
      agentExecutionOptions.set(machine as object, machineOptions);
      // Carry the wait-state predicate on the machine's root `config` (shared by
      // reference across `.provide`), so it survives provide/executor rebinding.
      if (config.isIdle) {
        const rootConfig = (machine as { config?: object }).config;
        if (rootConfig) {
          machineIdlePredicates.set(rootConfig, config.isIdle);
        }
      }
      return machine;
    },
    schemas,
    models,
    requests: requestActors,
    appendMessages,
  }) as unknown as SetupAgentResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels,
    TEmittedSchemas,
    TStateSchemas
  >;
}

// Recursively collects every reached-final-state's `output` config in a machine config.
function collectFinalStateOutputs(
  states: Record<string, any> | undefined,
  outputs: unknown[] = [],
) {
  for (const state of Object.values(states ?? {})) {
    if (state?.type === "final" && state.output !== undefined) {
      outputs.push(state.output);
    }
    collectFinalStateOutputs(state?.states, outputs);
  }

  return outputs;
}

// Sugar: when a machine config has no root `output` but exactly one final state declares one, promotes it to the root `output` (so `snapshot.output` is set without repeating the same output on every final state).
function withRootOutputFromSingleFinal<TConfig>(config: TConfig): TConfig {
  if (!config || typeof config !== "object" || "output" in config || !("states" in config)) {
    return config;
  }

  const outputs = collectFinalStateOutputs((config as { states?: Record<string, any> }).states);

  return outputs.length === 1 ? ({ ...config, output: outputs[0] } as TConfig) : config;
}

export namespace setupAgent {
  /**
   * Builds a state machine from a serializable {@link AgentWorkflowConfig}
   * (JSON/YAML) instead of the TypeScript `setupAgent(...)` API — the same
   * kind of machine a database, visual editor, or LLM could produce and hand
   * back. Requires a `compileSchema` (see {@link FromConfigOptions}) since
   * the library bundles no JSON Schema engine itself; bring Ajv,
   * @cfworker/json-schema, or another compiler that returns Standard Schema.
   *
   * Returns the built `machine` plus the compiled `schemas` pack (context,
   * events, input, output, meta, emitted) — a JSON-authored agent has no
   * TypeScript types, so hosts need the runtime schemas for things like
   * validating an inbound raw event with `parseAgentEvent`.
   *
   * @example
   * ```ts
   * const { machine, schemas } = setupAgent.fromConfig(workflowConfig, {
   *   compileSchema,
   * });
   * const result = await runAgent(machine, { input: { ticket }, executors: { generateText, decide } });
   * const event = parseAgentEvent(result.snapshot, raw, { events: schemas.events });
   * ```
   */
  export function fromConfig(
    config: AgentWorkflowConfig,
    options: FromConfigOptions,
  ): FromConfigResult {
    return setupAgentFromConfig(config, options);
  }
}

/**
 * The schema pack a machine was built with — `setupAgent(...).createMachine`
 * and `setupAgent.fromConfig(...)` both register one, so hosts can read a
 * machine's input/event schemas at runtime without knowing how it was
 * authored. Returns `undefined` for machines not built by either (a plain
 * xstate `createMachine`/`setup` machine).
 *
 * Registration is keyed on the machine object, so a machine returned by
 * `machine.provide(...)` carries no pack — read it from the machine the setup
 * returned.
 */
export function getAgentSchemas(machine: AnyStateMachine): AgentSchemas | undefined {
  return agentExecutionOptions.get(machine as object)?.schemas;
}

/** Builds one TextLogic actor per `setupAgent({ requests })` entry. @internal */
export function createRequestActors<
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
>(requests: AgentRequestInput<TRequestSchemas, TModel>): RequestActors<TRequestSchemas> {
  return Object.fromEntries(
    Object.entries(requests).map(([key, request]) => {
      const logic = createTextLogic({
        ...request,
        // The request's key is its name — stamped onto every lowered
        // AgentTextRequest so hosts/mocks can route without sniffing prompts.
        name: key,
        mode: request.mode ?? "generate",
      } as TextLogicConfig<StandardSchemaV1, StandardSchemaV1>);

      return [key, logic];
    }),
  ) as RequestActors<TRequestSchemas>;
}

// Accepts either form of setupAgent's schema config (`{ schemas: pack }` or a loose AgentSchemaConfig) and returns a resolved AgentSchemaPack.
function normalizeAgentSchemas<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends AgentEventSchemaInputMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TEmittedSchemas extends Record<string, StandardSchemaV1> = {},
>(
  config:
    | {
        schemas: AgentSchemaPack<
          TContextSchema,
          TEventSchemas,
          TInputSchema,
          TOutputSchema,
          TMetaSchema,
          TEmittedSchemas
        >;
      }
    | AgentSchemaConfig<
        TContextSchema,
        TEventSchemas,
        TInputSchema,
        TOutputSchema,
        TMetaSchema,
        TEmittedSchemas
      >,
): AgentSchemaPack<
  TContextSchema,
  WithAgentUsageEvent<TEventSchemas>,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TEmittedSchemas
> {
  if ("schemas" in config && config.schemas) {
    // A pack built by `createAgentSchemas` already carries the reserved
    // `'@agent.usage'` entry; a hand-built one gets it here (and is rejected if
    // it declares its own).
    return {
      ...config.schemas,
      events: normalizeEventSchemas(
        withAgentUsageEventSchema(config.schemas.events),
      ) as NormalizedEventSchemas<WithAgentUsageEvent<TEventSchemas>>,
    };
  }
  const loose = config as AgentSchemaConfig<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TEmittedSchemas
  >;
  return createAgentSchemas<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TEmittedSchemas
  >({
    ...loose,
    context: loose.context,
  });
}

/**
 * Runtime guard: every key of the `setupAgent({ states })` narrowing map must
 * name a real state node in the machine config. A typo'd key is otherwise a
 * silent no-op — the narrowing simply never applies — so fail fast at
 * `createMachine` time. Walks nested `states` maps in parallel with the
 * machine config, since narrowing entries nest the same way.
 */
function assertStateSchemaKeysExist(
  stateSchemas: Record<string, AgentSetupStateSchema> | undefined,
  machineStates: Record<string, any> | undefined,
  path: readonly string[] = [],
): void {
  if (!stateSchemas) {
    return;
  }

  for (const [key, stateSchema] of Object.entries(stateSchemas)) {
    const machineState = machineStates?.[key];
    if (!machineState || typeof machineState !== "object") {
      const validKeys = Object.keys(machineStates ?? {});
      const parent = path.length > 0 ? ` of state '${path.join(".")}'` : "";
      throw new Error(
        `setupAgent: 'states' key '${[...path, key].join(".")}' does not name a state in the ` +
          `machine config, so its context narrowing would silently never apply. Valid child ` +
          `states${parent}: ${validKeys.join(", ") || "(none)"}. Fix the key to match a state ` +
          `in createMachine({ states }), or remove it from setupAgent({ states }).`,
      );
    }

    if (
      stateSchema &&
      typeof stateSchema === "object" &&
      "states" in stateSchema &&
      stateSchema.states
    ) {
      assertStateSchemaKeysExist(
        stateSchema.states as Record<string, AgentSetupStateSchema>,
        machineState.states as Record<string, any> | undefined,
        [...path, key],
      );
    }
  }
}

// The builtin `agent.*` actor keys — reserved so a user `actors`/
// `requests` entry cannot silently clobber a builtin via spread order.
const RESERVED_AGENT_ACTOR_KEYS = [
  ...(Object.keys(builtinTextActors) as (keyof typeof builtinTextActors)[]),
  USER_INPUT_ACTOR,
  DECIDE_ACTOR,
] satisfies readonly (keyof BuiltinAgentActors)[];

/**
 * The whole `agent.` actor-source namespace is reserved for the library, not
 * just the shipped builtins: a key starting with this prefix is rejected at
 * setup time so a future builtin can never collide with (or be shadowed by) a
 * user source. Name your own sources without it.
 */
const RESERVED_AGENT_KEY_PREFIX = "agent.";

/**
 * Runtime guards over the user-supplied `actors`/`requests` keys, in one walk
 * of both groups:
 *
 * 1. A key in the reserved `agent.` namespace is rejected — every key with
 *    that prefix, not only today's builtins. Without this, the builtins-first
 *    spread in {@link createAgentActors} lets such a key overwrite the builtin
 *    (`agent.decide`, …) silently, and a builtin added later would start
 *    colliding with user code. Deliberate override of a builtin is still
 *    possible after the machine is created, via
 *    `machine.provide({ actors: { 'agent.decide': ... } })`.
 * 2. A key appearing in BOTH groups is almost certainly a mistake (whichever
 *    spread applies last would silently win) — fail fast with a clear message
 *    rather than let one implementation shadow another.
 */
function assertActorKeys(
  actors: Record<string, unknown> | undefined,
  requests: Record<string, unknown>,
): void {
  const seenIn = new Map<string, string>();
  const groups: [string, Record<string, unknown> | undefined][] = [
    ["actors", actors],
    ["requests", requests],
  ];

  for (const [groupName, group] of groups) {
    for (const key of Object.keys(group ?? {})) {
      if (RESERVED_AGENT_ACTOR_KEYS.some((reserved) => reserved === key)) {
        throw new Error(
          `setupAgent: '${groupName}' key '${key}' is a reserved builtin agent actor and ` +
            `cannot be redefined here (it would silently clobber the builtin). Reserved keys: ` +
            `${RESERVED_AGENT_ACTOR_KEYS.join(", ")}. To deliberately override a builtin, do it ` +
            `on the created machine instead: machine.provide({ actors: { '${key}': ... } }).`,
        );
      }
      if (key.startsWith(RESERVED_AGENT_KEY_PREFIX)) {
        throw new Error(
          `setupAgent: '${groupName}' key '${key}' uses the reserved '` +
            `${RESERVED_AGENT_KEY_PREFIX}' namespace, which belongs to the library (` +
            `${RESERVED_AGENT_ACTOR_KEYS.join(", ")}, and anything added later). Rename it ` +
            `without the '${RESERVED_AGENT_KEY_PREFIX}' prefix.`,
        );
      }
      const existingGroup = seenIn.get(key);
      if (existingGroup) {
        throw new Error(
          `setupAgent: key '${key}' is defined in both '${existingGroup}' and ` +
            `'${groupName}'. Each actor source key must be unique across ` +
            `'actors' and 'requests'.`,
        );
      }
      seenIn.set(key, groupName);
    }
  }
}

// Merges the builtin `agent.*` actors with user `actors` and generated request actors, after checking for key collisions. Exported for workflow-config's fromConfig lowering. @internal
export function createAgentActors<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
>(
  actors: TActors | undefined,
  requestActors: RequestActors<TRequestSchemas>,
): SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>, string, TModel>> {
  assertActorKeys(
    actors as Record<string, unknown> | undefined,
    requestActors as Record<string, unknown>,
  );

  return {
    ...builtinTextActors,
    [USER_INPUT_ACTOR]: userInputActor,
    [DECIDE_ACTOR]: createDecideActor(),
    ...actors,
    ...requestActors,
  } as SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>, string, TModel>>;
}
