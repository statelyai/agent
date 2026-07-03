import {
  setup,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnySetupConfig,
  type AnyStateMachine,
  type AsyncActorLogic,
  type EventFromLogic,
  type EventObject,
  type MachineContext,
  type MetaObject,
  type NonReducibleUnknown,
  type SetupReturnFromConfig,
  type SnapshotFrom,
} from 'xstate';
import type {
  AgentMessage,
  EventUnion,
  InferOutput,
  StandardSchemaV1,
} from './types.js';
import {
  builtinTextActors,
  createTextLogic,
  userInputActor,
  DECIDE_ACTOR,
  USER_INPUT_ACTOR,
  type AgentModelMap,
  type AgentModelRef,
  type AgentRequestExecutors,
  type AgentRequestMode,
  type BuiltinAgentActors,
  type TextLogic,
  type TextLogicConfig,
} from './text-logic.js';
import { createDecideActor } from './decision.js';
import type { AgentRequestOptions } from './events.js';
import {
  executeAgentRequest,
  getMachineAgentRequests,
  initialAgentStep,
  resolveAgentStep,
  transitionAgentStep,
  type AgentRequest,
  type AgentStep,
  type AgentStepRequest,
} from './steps.js';
import { appendMessages } from './messages.js';
import { agentExecutionOptions } from './internal/registry.js';
import {
  setupAgentFromConfig,
  type AgentWorkflowConfig,
  type FromConfigOptions,
} from './workflow-config.js';

// ─── setupAgent ───

type Constrain<T, TConstraint> = T extends TConstraint ? T : TConstraint;

type ContextOf<TContextSchema extends StandardSchemaV1> = Constrain<
  InferOutput<TContextSchema>,
  MachineContext
>;
type EventsOf<TEventSchemas extends Record<string, StandardSchemaV1>> =
  Constrain<EventUnion<TEventSchemas>, EventObject>;
type MetaOf<TMetaSchema extends StandardSchemaV1> = Constrain<
  InferOutput<TMetaSchema>,
  MetaObject
>;
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

export interface AgentSchemaPack<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>> = StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1> = Record<string, StandardSchemaV1>,
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetaSchema extends StandardSchemaV1 = StandardSchemaV1<MetaObject>,
> {
  context: TContextSchema;
  events: TEventSchemas;
  input: TInputSchema;
  output: TOutputSchema;
  meta: TMetaSchema;
}

type AgentSchemaConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
> = {
  context: TContextSchema;
  events?: TEventSchemas;
  input?: TInputSchema;
  output?: TOutputSchema;
  meta?: TMetaSchema;
};

export function createAgentSchemas<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1> = {},
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetaSchema extends StandardSchemaV1 = StandardSchemaV1<MetaObject>,
>(
  schemas: AgentSchemaConfig<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
  >
): AgentSchemaPack<
  TContextSchema,
  TEventSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema
> {
  return {
    context: schemas.context,
    events: (schemas.events ?? {}) as TEventSchemas,
    input: schemas.input as TInputSchema,
    output: schemas.output as TOutputSchema,
    meta: schemas.meta as TMetaSchema,
  };
}

export type AgentRequestConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = Record<string, unknown>,
  TModel extends string = string,
> = TextLogicConfig<TInputSchema, TOutputSchema, TMetadata, TModel> & {
  mode?: AgentRequestMode;
};

export type AgentRequestSchemaMap = Record<
  string,
  {
    input: StandardSchemaV1;
    output: StandardSchemaV1;
  }
>;

export type AgentRequestInput<
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
> = {
  [K in keyof TRequestSchemas]: AgentRequestConfig<
    TRequestSchemas[K]['input'],
    TRequestSchemas[K]['output'],
    Record<string, unknown>,
    TModel
  > & {
    schemas: TRequestSchemas[K];
  };
};

type RequestActors<TRequestSchemas extends AgentRequestSchemaMap> = {
  [K in keyof TRequestSchemas]: TextLogic<
    TRequestSchemas[K]['input'],
    TRequestSchemas[K]['output']
  >;
};

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
type AgentSetupEventsSchema<
  TEventSchemas extends Record<string, StandardSchemaV1>,
> = [keyof TEventSchemas] extends [never]
  ? {}
  : { events: TEventSchemas };

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
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
> = {
  schemas: {
    context: TContextSchema;
    input: TInputSchema;
    output: TOutputSchema;
    meta: TMetaSchema;
  } & AgentSetupEventsSchema<TEventSchemas>;
  actorSources: SetupActors<
    AgentSetupActors<
      AgentAllActors<TActors, TRequestSchemas>,
      keyof TEventSchemas & string,
      AgentModelRef<TModels>
    >
  >;
  actions?: NonNullable<AnySetupConfig['actions']>;
  guards?: NonNullable<AnySetupConfig['guards']>;
  delays?: NonNullable<AnySetupConfig['delays']>;
};

type SetupAgentBaseConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TRequestSchemas extends AgentRequestSchemaMap,
  TModels extends AgentModelMap,
> = (
  | {
      schemas: AgentSchemaPack<
        TContextSchema,
        TEventSchemas,
        TInputSchema,
        TOutputSchema,
        TMetaSchema
      >;
    }
  | AgentSchemaConfig<
      TContextSchema,
      TEventSchemas,
      TInputSchema,
      TOutputSchema,
      TMetaSchema
    >
) & {
  models?: TModels;
  actors?: TActors;
  requests?: AgentRequestInput<TRequestSchemas, AgentModelRef<TModels>>;
  actions?: NonNullable<AnySetupConfig['actions']>;
  guards?: NonNullable<AnySetupConfig['guards']>;
  delays?: NonNullable<AnySetupConfig['delays']>;
};

type SetupAgentXStateResult<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
> = SetupReturnFromConfig<
  AgentSetupXStateConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels
  >
>;

type SetupAgentResult<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
> = Omit<
  SetupAgentXStateResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels
  >,
  'createMachine'
> & {
  createMachine: SetupAgentXStateResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TModels
  >['createMachine'];
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
  >;
  readonly models: TModels;
  readonly requests: RequestActors<TRequestSchemas>;
  initial<TMachine extends AnyActorLogic>(
    machine: TMachine,
    input?: unknown
  ): AgentStep<SnapshotFrom<TMachine>>;
  transition<TMachine extends AnyActorLogic>(
    machine: TMachine,
    snapshotOrStep: SnapshotFrom<TMachine> | AgentStep<SnapshotFrom<TMachine>>,
    event: EventFromLogic<TMachine>
  ): AgentStep<SnapshotFrom<TMachine>>;
  resolve<TMachine extends AnyActorLogic>(
    machine: TMachine,
    step: AgentStep<SnapshotFrom<TMachine>>,
    request: Pick<AgentRequest, 'id'> | string,
    output: unknown
  ): AgentStep<SnapshotFrom<TMachine>>;
  getRequests(
    machine: AnyActorLogic,
    actions: readonly { type?: string; params?: unknown }[],
    snapshot?: AnyMachineSnapshot,
    options?: Pick<AgentRequestOptions, 'eventToolName'>
  ): AgentStepRequest[];
  execute(request: AgentRequest, executors: AgentRequestExecutors): Promise<unknown>;
  appendMessages(
    resolve:
      | AgentMessage
      | AgentMessage[]
      | ((args: {
          context: ContextOf<TContextSchema> & { messages: AgentMessage[] };
          event: any;
        }) => AgentMessage | AgentMessage[])
  ): ReturnType<
    typeof appendMessages<
      ContextOf<TContextSchema> & { messages: AgentMessage[] },
      EventsOf<TEventSchemas>
    >
  >;
};

/**
 * Schema-first `setup(...)` for agent machines. Context, events, machine
 * input, machine output, and state/transition meta are all standard
 * schemas — no `{} as Type` casts — and are retained on `result.schemas`
 * for runtime validation.
 */
export function setupAgent<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap = {},
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetaSchema extends StandardSchemaV1 = StandardSchemaV1<MetaObject>,
  TModels extends AgentModelMap = {},
>(
  config: SetupAgentBaseConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TRequestSchemas,
    TModels
  >
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TModels
> {
  return createSetupAgent(config);
}

function collectFinalStateOutputs(
  states: Record<string, any> | undefined,
  outputs: unknown[] = []
) {
  for (const state of Object.values(states ?? {})) {
    if (state?.type === 'final' && state.output !== undefined) {
      outputs.push(state.output);
    }
    collectFinalStateOutputs(state?.states, outputs);
  }

  return outputs;
}

function withRootOutputFromSingleFinal<TConfig>(config: TConfig): TConfig {
  if (
    !config
    || typeof config !== 'object'
    || 'output' in config
    || !('states' in config)
  ) {
    return config;
  }

  const outputs = collectFinalStateOutputs(
    (config as { states?: Record<string, any> }).states
  );

  return outputs.length === 1
    ? ({ ...config, output: outputs[0] } as TConfig)
    : config;
}

export namespace setupAgent {
  export function fromConfig(
    config: AgentWorkflowConfig,
    options: FromConfigOptions
  ): AnyStateMachine {
    return setupAgentFromConfig(config, options);
  }
}

export function createRequestActors<
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
>(requests: AgentRequestInput<TRequestSchemas, TModel>): RequestActors<TRequestSchemas> {
  return Object.fromEntries(
    Object.entries(requests).map(([key, request]) => {
      const logic = createTextLogic({
        ...request,
        mode: request.mode ?? 'generate',
      } as TextLogicConfig<StandardSchemaV1, StandardSchemaV1>);

      return [
        key,
        logic,
      ];
    })
  ) as RequestActors<TRequestSchemas>;
}

function normalizeAgentSchemas<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
>(
  config:
    | {
        schemas: AgentSchemaPack<
          TContextSchema,
          TEventSchemas,
          TInputSchema,
          TOutputSchema,
          TMetaSchema
        >;
      }
    | AgentSchemaConfig<
        TContextSchema,
        TEventSchemas,
        TInputSchema,
        TOutputSchema,
        TMetaSchema
      >
): AgentSchemaPack<
  TContextSchema,
  TEventSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema
> {
  return 'schemas' in config
    ? config.schemas
    : createAgentSchemas(config);
}

function normalizeAgentRequestInput<
  TRequestSchemas extends AgentRequestSchemaMap,
  TModel extends string = string,
>(
  requests: AgentRequestInput<TRequestSchemas, TModel> | undefined
): AgentRequestInput<TRequestSchemas, TModel> {
  return requests ?? ({} as AgentRequestInput<TRequestSchemas, TModel>);
}

/**
 * Runtime guard: a key appearing in both `actors`/`requests` is almost
 * certainly a mistake (whichever spread applies last would silently win) —
 * fail fast with a clear message rather than let one implementation shadow
 * another.
 */
function assertNoActorKeyCollisions(
  actors: Record<string, unknown> | undefined,
  requests: Record<string, unknown>
): void {
  const seenIn = new Map<string, string>();
  const groups: [string, Record<string, unknown> | undefined][] = [
    ['actors', actors],
    ['requests', requests],
  ];

  for (const [groupName, group] of groups) {
    for (const key of Object.keys(group ?? {})) {
      const existingGroup = seenIn.get(key);
      if (existingGroup) {
        throw new Error(
          `setupAgent: key '${key}' is defined in both '${existingGroup}' and ` +
            `'${groupName}'. Each actor source key must be unique across ` +
            `'actors' and 'requests'.`
        );
      }
      seenIn.set(key, groupName);
    }
  }
}

function createAgentActorSources<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
>(
  actors: TActors | undefined,
  requestActors: RequestActors<TRequestSchemas>
): SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>>> {
  assertNoActorKeyCollisions(
    actors as Record<string, unknown> | undefined,
    requestActors as Record<string, unknown>
  );

  return {
    ...builtinTextActors,
    [USER_INPUT_ACTOR]: userInputActor,
    [DECIDE_ACTOR]: createDecideActor(),
    ...actors,
    ...requestActors,
  } as SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>>>;
}

function createAgentSetupConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
>(
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
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
      TModels
    >,
    'actions' | 'guards' | 'delays'
  >
): AgentSetupXStateConfig<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TModels
> {
  return {
    schemas: {
      context: schemas.context,
      events: schemas.events,
      input: schemas.input,
      output: schemas.output,
      meta: schemas.meta,
    },
    actorSources,
    actions: config.actions,
    guards: config.guards,
    delays: config.delays,
  };
}

function createSetupAgent<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TModels extends AgentModelMap,
>(
  config: SetupAgentBaseConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TRequestSchemas,
    TModels
  >
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TModels
> {
  const schemas = normalizeAgentSchemas(config);
  const requests = normalizeAgentRequestInput<
    TRequestSchemas,
    AgentModelRef<TModels>
  >(config.requests);
  const requestActors = createRequestActors<TRequestSchemas, AgentModelRef<TModels>>(requests);
  const actorSources = createAgentActorSources(config.actors, requestActors);
  const setupConfig = createAgentSetupConfig<
      TContextSchema,
      TEventSchemas,
      TActors,
      TRequestSchemas,
      TInputSchema,
      TOutputSchema,
      TMetaSchema,
      TModels
    >(schemas, actorSources, config);
  const base = setup(setupConfig);
  const createBaseMachine = base.createMachine.bind(base);
  const machineOptions = {
    schemas,
    actors: actorSources,
  };
  const models = (config.models ?? {}) as TModels;

  return Object.assign(base, {
    createMachine(machineConfig: Parameters<typeof base.createMachine>[0]) {
      const machine = createBaseMachine(
        withRootOutputFromSingleFinal(machineConfig) as never
      );
      agentExecutionOptions.set(machine as object, machineOptions);
      return machine;
    },
    schemas,
    models,
    requests: requestActors,
    initial(machine: AnyActorLogic, input?: unknown) {
      return initialAgentStep(machine, input, machineOptions);
    },
    transition(
      machine: AnyActorLogic,
      snapshotOrStep: AnyMachineSnapshot | AgentStep,
      event: EventObject
    ) {
      return transitionAgentStep(
        machine,
        snapshotOrStep as never,
        event as never,
        machineOptions
      );
    },
    resolve(
      machine: AnyActorLogic,
      step: AgentStep,
      request: Pick<AgentRequest, 'id'> | string,
      output: unknown
    ) {
      return resolveAgentStep(machine, step as never, request, output, machineOptions);
    },
    getRequests(
      machine: AnyActorLogic,
      actions: readonly { type?: string; params?: unknown }[],
      snapshot?: AnyMachineSnapshot,
      requestOptions: Pick<AgentRequestOptions, 'eventToolName'> = {}
    ) {
      return getMachineAgentRequests(machine, actions, snapshot, {
        ...machineOptions,
        ...requestOptions,
      });
    },
    execute(request: AgentRequest, executors: AgentRequestExecutors) {
      return executeAgentRequest(request, executors);
    },
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
    TModels
  >;
}
