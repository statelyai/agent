import {
  setup,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnySetupConfig,
  type AnyStateMachine,
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
  InferOutput,
  NormalizedEventSchemas,
  StandardSchemaV1,
} from "./types.js";
import {
  builtinTextActors,
  createTextLogic,
  userInputActor,
  DECIDE_ACTOR,
  PLAN_ACTOR,
  USER_INPUT_ACTOR,
  type AgentModelMap,
  type AgentModelRef,
  type AgentRequestMode,
  type BuiltinAgentActors,
  type TextLogic,
  type TextLogicConfig,
} from "./text-logic.js";
import { createDecideActor, createPlanActor } from "./decision.js";
import { appendMessages } from "./messages.js";
import { agentExecutionOptions, machineSuspensionPredicates } from "./internal/registry.js";
import {
  setupAgentFromConfig,
  type AgentWorkflowConfig,
  type FromConfigOptions,
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
  TEventSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TEmittedSchemas
> {
  return {
    context: schemas.context,
    events: normalizeEventSchemas(schemas.events ?? {}) as NormalizedEventSchemas<TEventSchemas>,
    input: schemas.input as TInputSchema,
    output: schemas.output as TOutputSchema,
    meta: schemas.meta as TMetaSchema,
    emitted: schemas.emitted as TEmittedSchemas,
  };
}

// One `setupAgent({ requests })` entry's config — a TextLogicConfig plus the generate/stream `mode`.
export type AgentRequestConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = Record<string, unknown>,
  TModel extends string = string,
> = TextLogicConfig<TInputSchema, TOutputSchema, TMetadata, TModel> & {
  mode?: AgentRequestMode;
};

// Maps request keys to their input/output schema pair — the shape `setupAgent({ requests })` and `AgentRequestInput` are keyed by.
export type AgentRequestSchemaMap = Record<
  string,
  {
    input: StandardSchemaV1;
    output: StandardSchemaV1;
  }
>;

// The full `setupAgent({ requests })` map: one AgentRequestConfig per schema-map entry, each carrying its own schemas.
export type AgentRequestInput<
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
> = {
  [K in keyof TRequestSchemas]: AgentRequestConfig<
    TRequestSchemas[K]["input"],
    TRequestSchemas[K]["output"],
    Record<string, unknown>,
    TModel
  > & {
    schemas: TRequestSchemas[K];
  };
};

// The TextLogic actors createRequestActors builds from an AgentRequestInput — one per request key.
type RequestActors<TRequestSchemas extends AgentRequestSchemaMap> = {
  [K in keyof TRequestSchemas]: TextLogic<
    TRequestSchemas[K]["input"],
    TRequestSchemas[K]["output"]
  >;
};

// User-declared `actors` merged with the TextLogic actors generated from `requests`.
type AgentAllActors<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
> = TActors & RequestActors<TRequestSchemas>;

// Emit the `events` schema key ONLY when there are event schemas. When
// `TEventSchemas` is empty (`{}`), the key is omitted entirely so xstate falls
// back to its `createMachine`-level event inference. Passing a present-but-
// empty `events: {}` makes `SetupEvents` compute `InferEvents<{}>` → `never`,
// which sets the machine's `TEvent` to `never` and cascades into `context`
// collapsing to `never` too (this reproduces with *raw* `setup({ schemas: {
// context, events: {} } })`, so it is an xstate-alpha behavior we route
// around by matching how hand-written setup omits an empty `events`).
type AgentSetupEventsSchema<TEventSchemas extends AgentEventSchemaInputMap> = [
  keyof TEventSchemas,
] extends [never]
  ? {}
  : { events: NormalizedEventSchemas<TEventSchemas> };

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
    input: TInputSchema;
    output: TOutputSchema;
    meta: TMetaSchema;
  } & AgentSetupEventsSchema<TEventSchemas> &
    AgentSetupEmittedSchema<TEmittedSchemas>;
  // Per-state schemas (xstate `setup({ states })`): narrows `context` inside
  // the declared states (invoke inputs, transition fns, final outputs).
  states?: TStateSchemas;
  actorSources: SetupActors<
    AgentSetupActors<
      AgentAllActors<TActors, TRequestSchemas>,
      keyof TEventSchemas & string,
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
  actorSources?: TActors;
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
   * what "suspended" means for it, so `runAgent` settles those snapshots idle
   * deterministically instead of using its timing heuristic. Travels with the
   * machine through `machine.provide(...)`. A `runAgent({ isSuspended })` host
   * override takes precedence; with neither, `runAgent` falls back to the timing
   * heuristic. Declare your own signal — e.g. `(s) => s.hasTag('awaiting-review')`
   * or `(s) => getStateMeta(s).interaction !== undefined`.
   */
  isSuspended?: (snapshot: AnyMachineSnapshot) => boolean;
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
  /** The retained schema pack ({@link AgentSchemaPack}) for host-side validation and tooling. */
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
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
      EventsOf<TEventSchemas>
    >
  >;
};

/** Typed machine config used by convenience authoring layers built on `setupAgent`. */
export type AgentMachineConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TInputSchema extends StandardSchemaV1,
  TEventSchemas extends AgentEventSchemaInputMap = {},
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TModels extends AgentModelMap = {},
> = Parameters<
  SetupAgentResult<
    TContextSchema,
    TEventSchemas,
    {},
    {},
    TInputSchema,
    TOutputSchema,
    StandardSchemaV1<MetaObject>,
    TModels
  >["createMachine"]
>[0];

/** Machine produced from {@link AgentMachineConfig}. */
export type AgentMachine<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TInputSchema extends StandardSchemaV1,
  TEventSchemas extends AgentEventSchemaInputMap = {},
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TModels extends AgentModelMap = {},
> = ReturnType<
  SetupAgentResult<
    TContextSchema,
    TEventSchemas,
    {},
    {},
    TInputSchema,
    TOutputSchema,
    StandardSchemaV1<MetaObject>,
    TModels
  >["createMachine"]
>;

/**
 * Schema-first `setup(...)` for agent machines — the standard entry point
 * for authoring a machine (the blueprint) that this library then runs (via
 * {@link runAgent} or the step helpers) against host-supplied model/decision
 * executors. Context, events, machine input, machine output, and
 * state/transition meta are all standard schemas — no `{} as Type` casts —
 * and are retained on `result.schemas` for runtime validation. Also
 * registers the `agent.generateText`/`agent.streamText`/`agent.userInput`/
 * `agent.decide` builtin actors and lowers `requests`/`actorSources` into the
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
 *   actorSources: { tellJoke },
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
  return createSetupAgent(config);
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
   * @example
   * ```ts
   * const machine = setupAgent.fromConfig(workflowConfig, {
   *   compileSchema,
   * });
   * const result = await runAgent(machine, { input: { ticket }, executors: { generateText, decide } });
   * ```
   */
  export function fromConfig(
    config: AgentWorkflowConfig,
    options: FromConfigOptions,
  ): AnyStateMachine {
    return setupAgentFromConfig(config, options);
  }
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
  TEventSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TEmittedSchemas
> {
  if ("schemas" in config && config.schemas) {
    return config.schemas;
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

// Defaults an omitted `setupAgent({ requests })` to an empty object.
function normalizeAgentRequestInput<
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
>(
  requests: AgentRequestInput<TRequestSchemas, TModel> | undefined,
): AgentRequestInput<TRequestSchemas, TModel> {
  return requests ?? ({} as AgentRequestInput<TRequestSchemas, TModel>);
}

/**
 * Runtime guard: a key appearing in both `actorSources`/`requests` is almost
 * certainly a mistake (whichever spread applies last would silently win) —
 * fail fast with a clear message rather than let one implementation shadow
 * another.
 */
function assertNoActorKeyCollisions(
  actorSources: Record<string, unknown> | undefined,
  requests: Record<string, unknown>,
): void {
  const seenIn = new Map<string, string>();
  const groups: [string, Record<string, unknown> | undefined][] = [
    ["actorSources", actorSources],
    ["requests", requests],
  ];

  for (const [groupName, group] of groups) {
    for (const key of Object.keys(group ?? {})) {
      const existingGroup = seenIn.get(key);
      if (existingGroup) {
        throw new Error(
          `setupAgent: key '${key}' is defined in both '${existingGroup}' and ` +
            `'${groupName}'. Each actor source key must be unique across ` +
            `'actorSources' and 'requests'.`,
        );
      }
      seenIn.set(key, groupName);
    }
  }
}

// The builtin `agent.*` actor keys — reserved so a user `actorSources`/
// `requests` entry cannot silently clobber a builtin via spread order.
const RESERVED_AGENT_ACTOR_KEYS: readonly string[] = [
  ...Object.keys(builtinTextActors),
  USER_INPUT_ACTOR,
  DECIDE_ACTOR,
  PLAN_ACTOR,
];

/**
 * Rejects a user-supplied `actorSources`/`requests` key in the reserved
 * `agent.*` builtin namespace. Without this, the builtins-first spread in
 * {@link createAgentActorSources} lets such a key overwrite the builtin
 * (`agent.decide`, `agent.plan`, …) silently. Deliberate override of a builtin
 * is still possible after the machine is created, via
 * `machine.provide({ actorSources: { 'agent.decide': ... } })`.
 */
function assertNoReservedAgentKeys(
  actorSources: Record<string, unknown> | undefined,
  requests: Record<string, unknown>,
): void {
  const groups: [string, Record<string, unknown> | undefined][] = [
    ["actorSources", actorSources],
    ["requests", requests],
  ];
  for (const [groupName, group] of groups) {
    for (const key of Object.keys(group ?? {})) {
      if (RESERVED_AGENT_ACTOR_KEYS.includes(key)) {
        throw new Error(
          `setupAgent: '${groupName}' key '${key}' is a reserved builtin agent actor and ` +
            `cannot be redefined here (it would silently clobber the builtin). Reserved keys: ` +
            `${RESERVED_AGENT_ACTOR_KEYS.join(", ")}. To deliberately override a builtin, do it ` +
            `on the created machine instead: machine.provide({ actorSources: { '${key}': ... } }).`,
        );
      }
    }
  }
}

// Merges the four builtin `agent.*` actors with user `actors` and generated request actors, after checking for key collisions.
function createAgentActorSources<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
>(
  actorSources: TActors | undefined,
  requestActors: RequestActors<TRequestSchemas>,
): SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>, string, TModel>> {
  assertNoActorKeyCollisions(
    actorSources as Record<string, unknown> | undefined,
    requestActors as Record<string, unknown>,
  );
  assertNoReservedAgentKeys(
    actorSources as Record<string, unknown> | undefined,
    requestActors as Record<string, unknown>,
  );

  return {
    ...builtinTextActors,
    [USER_INPUT_ACTOR]: userInputActor,
    [DECIDE_ACTOR]: createDecideActor(),
    [PLAN_ACTOR]: createPlanActor(),
    ...actorSources,
    ...requestActors,
  } as SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>, string, TModel>>;
}

// Assembles the plain-object config passed to xstate's setup(...) (see AgentSetupXStateConfig's note on why it's not SetupConfig<...>).
function createAgentSetupConfig<
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
>(
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TEmittedSchemas
  >,
  actorSources: SetupActors<
    AgentSetupActors<
      AgentAllActors<TActors, TRequestSchemas>,
      keyof TEventSchemas & string,
      AgentModelRef<TModels>
    >
  >,
  config: Pick<
    SetupAgentBaseConfig<
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
    "actions" | "guards" | "delays" | "states"
  >,
): AgentSetupXStateConfig<
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
> {
  return {
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
    actorSources,
    actions: config.actions,
    guards: config.guards,
    delays: config.delays,
  };
}

// Implementation backing the public setupAgent(...) function: normalizes schemas/requests, builds actor sources, calls xstate's setup(...), and layers on the agent-specific result extensions (a wrapped createMachine plus schemas/models/requests/appendMessages).
function createSetupAgent<
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
  const requests = normalizeAgentRequestInput<TRequestSchemas, AgentModelRef<TModels>>(
    config.requests,
  );
  const requestActors = createRequestActors<TRequestSchemas, AgentModelRef<TModels>>(requests);
  const actorSources = createAgentActorSources<TActors, TRequestSchemas, AgentModelRef<TModels>>(
    config.actorSources,
    requestActors,
  );
  const setupConfig = createAgentSetupConfig<
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
  >(schemas, actorSources, config);
  const base = setup(setupConfig);
  const createBaseMachine = base.createMachine.bind(base);
  const models = (config.models ?? {}) as TModels;
  const machineOptions = {
    schemas,
    actorSources,
    models,
  };

  return Object.assign(base, {
    createMachine(machineConfig: Parameters<typeof base.createMachine>[0]) {
      const machine = createBaseMachine(withRootOutputFromSingleFinal(machineConfig) as never);
      agentExecutionOptions.set(machine as object, machineOptions);
      // Carry the wait-state predicate on the machine's root `config` (shared by
      // reference across `.provide`), so it survives provide/executor rebinding.
      if (config.isSuspended) {
        const rootConfig = (machine as { config?: object }).config;
        if (rootConfig) {
          machineSuspensionPredicates.set(rootConfig, config.isSuspended);
        }
      }
      return machine;
    },
    schemas,
    models,
    requests: requestActors,
    appendMessages(resolve: Parameters<typeof appendMessages>[0]) {
      return appendMessages(resolve);
    },
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
