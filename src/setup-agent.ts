import {
  fromPromise,
  getNextTransitions,
  setup,
  transition,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type EventObject,
  type ExecutableActionsFrom,
  type MachineContext,
  type MetaObject,
  type NonReducibleUnknown,
  type ParameterizedObject,
  type PromiseActorLogic,
  type SnapshotFrom,
} from 'xstate';
import type {
  AgentMessage,
  AgentToolChoice,
  AgentTools,
  EventUnion,
  InferOutput,
  StandardSchemaV1,
} from './types.js';
import { validateSchemaSync } from './utils.js';

// ─── Built-in text actors ───
//
// `agent.generate` and `agent.stream` are well-known actor sources
// registered by `setupAgent`. The machine declares the call; the host
// provides the execution (via `machine.provide({ actors })` or a runtime
// adapter). Streaming is a host concern: `agent.stream` resolves with
// the final text once the stream completes — incremental chunks flow
// through the host's side channel (HTTP stream, WebSocket, stdout), never
// through the machine's journal.

/** Portable LCD input both built-in text actors receive. */
export interface AgentTextInput<TMetadata = unknown> {
  model: string;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  /** Host/model tools that are always available to this text call. */
  tools?: AgentTools;
  toolChoice?: AgentToolChoice;
  /** Machine event types to expose as model-call tools for this state. */
  allowedEvents?: readonly string[];
  outputSchema?: StandardSchemaV1;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  /**
   * Host-owned per-call options. Use this for provider/runtime details such
   * as Cloudflare bindings, tracing IDs, SDK provider options, or transport
   * hints. The machine carries it; the host decides what it means.
   */
  metadata?: TMetadata;
}

const AGENT_GENERATE_SRC = 'agent.generate' as const;
const AGENT_STREAM_SRC = 'agent.stream' as const;

// `generateText` output is `any` at the actor level on purpose: generated
// object shapes are runtime data. Keep `onDone` plain XState and validate
// with the shared `input.outputSchema` where you assign/use the value.
type BuiltinTextActors = {
  'agent.generate': PromiseActorLogic<any, AgentTextInput>;
  'agent.stream': PromiseActorLogic<string, AgentTextInput>;
};

function missingHostActor(src: string): PromiseActorLogic<any, AgentTextInput> {
  return fromPromise<any, AgentTextInput>(async () => {
    throw new Error(
      `'${src}' has no host execution. Provide an implementation with ` +
        `machine.provide({ actors: { '${src}': ... } }) or run the machine ` +
        `through an agent runtime adapter.`
    );
  });
}

// ─── Message helpers ───
//
// Messages are plain context state: declare a `messages` field in the
// context schema and update it with `assign`. `addMessages` is a property
// assigner for that idiom — it appends instead of replacing:
//
//   actions: assign({
//     messages: addMessages(({ event }) => userMessage(event.prompt)),
//   })

export {
  appendMessages,
  assistantMessage,
  systemMessage,
  userMessage,
  validateSchemaSync,
} from './utils.js';

export function addMessages<
  TContext extends { messages: AgentMessage[] },
  TEvent extends EventObject,
>(
  resolve:
    | AgentMessage
    | AgentMessage[]
    | ((args: { context: TContext; event: TEvent }) => AgentMessage | AgentMessage[]),
): (args: { context: TContext; event: TEvent }) => AgentMessage[] {
  return (args) => {
    const resolved =
      typeof resolve === 'function' ? resolve(args) : resolve;
    return [
      ...args.context.messages,
      ...(Array.isArray(resolved) ? resolved : [resolved]),
    ];
  };
}

/** Standard schema for an `AgentMessage[]` context field. */
export const messagesSchema: StandardSchemaV1<AgentMessage[]> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      const ok =
        Array.isArray(value)
        && value.every(
          (message) =>
            !!message
            && typeof message === 'object'
            && typeof (message as AgentMessage).role === 'string'
            && typeof (message as AgentMessage).content === 'string'
        );
      return ok
        ? { value: value as AgentMessage[] }
        : { issues: [{ message: 'Expected an array of agent messages' }] };
    },
  },
};

export function parseOutput<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  output: unknown
): InferOutput<TSchema> {
  return validateSchemaSync<InferOutput<TSchema>>(
    schema as StandardSchemaV1<InferOutput<TSchema>>,
    output
  );
}

type ResolveTextLogicValue<TValue, TInput> =
  | TValue
  | ((args: { input: TInput }) => TValue);

function resolveTextLogicValue<TValue, TInput>(
  value: ResolveTextLogicValue<TValue, TInput> | undefined,
  args: { input: TInput }
): TValue | undefined {
  return typeof value === 'function'
    ? (value as (args: { input: TInput }) => TValue)(args)
    : value;
}

export interface TextLogicConfig<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata = unknown,
> {
  schemas: {
    input: TInputSchema;
    output: TOutputSchema;
  };
  model: ResolveTextLogicValue<string, InferOutput<TInputSchema>>;
  system?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  prompt?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  messages?: ResolveTextLogicValue<
    AgentMessage[] | undefined,
    InferOutput<TInputSchema>
  >;
  tools?: ResolveTextLogicValue<AgentTools | undefined, InferOutput<TInputSchema>>;
  toolChoice?: ResolveTextLogicValue<
    AgentToolChoice | undefined,
    InferOutput<TInputSchema>
  >;
  allowedEvents?: ResolveTextLogicValue<
    readonly string[] | undefined,
    InferOutput<TInputSchema>
  >;
  temperature?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  maxTokens?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topP?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topK?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  seed?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  stopSequences?: ResolveTextLogicValue<
    string[] | undefined,
    InferOutput<TInputSchema>
  >;
  metadata?: ResolveTextLogicValue<TMetadata | undefined, InferOutput<TInputSchema>>;
}

export interface TextLogicExecuteArgs<TInput, TMetadata = unknown> {
  input: TInput;
  request: AgentTextInput<TMetadata>;
  signal: AbortSignal;
  system: unknown;
  self: unknown;
  emit: (emitted: EventObject) => void;
}

export type TextLogicExecutor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata = unknown,
> = (
  args: TextLogicExecuteArgs<InferOutput<TInputSchema>, TMetadata>
) => PromiseLike<InferOutput<TOutputSchema>>;

export interface TextLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = unknown,
> extends PromiseActorLogic<
    InferOutput<TOutputSchema>,
    InferOutput<TInputSchema>
  > {
  readonly kind: 'statelyai.textLogic';
  readonly schemas: {
    readonly input: TInputSchema;
    readonly output: TOutputSchema;
  };
  request(input: InferOutput<TInputSchema>): AgentTextInput<TMetadata>;
  withExecutor(
    execute: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>
  ): TextLogic<TInputSchema, TOutputSchema, TMetadata>;
}

export type AgentTaskKind = 'generate' | 'stream';

export interface AgentTaskLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = unknown,
> extends TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  readonly taskKind: AgentTaskKind;
}

export type TextLogicInput<TLogic extends TextLogic> =
  TLogic extends TextLogic<infer TInputSchema, StandardSchemaV1, infer _TMetadata>
    ? InferOutput<TInputSchema>
    : never;

export type TextLogicOutput<TLogic extends TextLogic> =
  TLogic extends TextLogic<StandardSchemaV1, infer TOutputSchema, infer _TMetadata>
    ? InferOutput<TOutputSchema>
    : never;

export function createTextLogic<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata = unknown,
>(
  config: TextLogicConfig<TInputSchema, TOutputSchema, TMetadata>,
  execute?: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  type TInput = InferOutput<TInputSchema>;
  type TOutput = InferOutput<TOutputSchema>;
  const request = (input: TInput): AgentTextInput<TMetadata> => {
    const parsedInput = validateSchemaSync<TInput>(
      config.schemas.input as StandardSchemaV1<TInput>,
      input
    );
    const args = { input: parsedInput };

    return {
      model: resolveTextLogicValue(config.model, args)!,
      system: resolveTextLogicValue(config.system, args),
      prompt: resolveTextLogicValue(config.prompt, args),
      messages: resolveTextLogicValue(config.messages, args),
      tools: resolveTextLogicValue(config.tools, args),
      toolChoice: resolveTextLogicValue(config.toolChoice, args),
      allowedEvents: resolveTextLogicValue(config.allowedEvents, args),
      outputSchema: config.schemas.output,
      temperature: resolveTextLogicValue(config.temperature, args),
      maxTokens: resolveTextLogicValue(config.maxTokens, args),
      topP: resolveTextLogicValue(config.topP, args),
      topK: resolveTextLogicValue(config.topK, args),
      seed: resolveTextLogicValue(config.seed, args),
      stopSequences: resolveTextLogicValue(config.stopSequences, args),
      metadata: resolveTextLogicValue(config.metadata, args),
    };
  };
  const logic = fromPromise<TOutput, TInput>(
    async ({ input, signal, system, self, emit }) => {
      const resolvedRequest = request(input);

      if (!execute) {
        throw new Error(
          'Text logic has no host execution. Pass an executor as the second ' +
            'argument to createTextLogic(...), provide a runtime adapter, or ' +
            'extract it with getAgentEffects(..., { actors }).'
        );
      }

      const output = await execute({
        input,
        request: resolvedRequest,
        signal,
        system,
        self,
        emit: emit as (emitted: EventObject) => void,
      });

      return validateSchemaSync<TOutput>(
        config.schemas.output as StandardSchemaV1<TOutput>,
        output
      );
    }
  );

  return Object.assign(logic, {
    kind: 'statelyai.textLogic' as const,
    schemas: config.schemas,
    request,
    withExecutor(
      nextExecute: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>
    ) {
      return createTextLogic(config, nextExecute);
    },
  }) as TextLogic<TInputSchema, TOutputSchema, TMetadata>;
}

function isTextLogic(value: unknown): value is TextLogic {
  return (
    !!value
    && typeof value === 'object'
    && (value as TextLogic).kind === 'statelyai.textLogic'
    && typeof (value as TextLogic).request === 'function'
  );
}

function isAgentTaskLogic(value: unknown): value is AgentTaskLogic {
  return isTextLogic(value) && typeof (value as AgentTaskLogic).taskKind === 'string';
}

export type AgentEffectSource = 'agent.generate' | 'agent.stream' | (string & {});

export const EVENT_TOOL_PREFIX = 'event.' as const;

export interface AgentEffect<TInput extends AgentTextInput = AgentTextInput> {
  id: string;
  src: AgentEffectSource;
  kind?: AgentTaskKind;
  input: TInput;
  tools: AgentTools;
  events: AgentEventDescriptor[];
}

export type AgentTask<TInput extends AgentTextInput = AgentTextInput> =
  AgentEffect<TInput>;

export interface AgentEventDescriptor {
  type: string;
  toolName: `${typeof EVENT_TOOL_PREFIX}${string}`;
  inputSchema?: StandardSchemaV1;
}

export interface AgentSchemas {
  events?: Record<string, StandardSchemaV1>;
}

export interface AgentEffectOptions {
  snapshot?: AnyMachineSnapshot;
  events?: Record<string, StandardSchemaV1>;
  schemas?: AgentSchemas;
  actors?: Record<string, unknown>;
}

function isAgentEffectSource(src: unknown): src is AgentEffectSource {
  return src === AGENT_GENERATE_SRC || src === AGENT_STREAM_SRC;
}

export function getAvailableEvents(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentEffectOptions, 'events' | 'schemas'> & {
    allowedEvents?: readonly string[];
  } = {}
): AgentEventDescriptor[] {
  const allowedEvents =
    options.allowedEvents === undefined
      ? undefined
      : new Set(options.allowedEvents);
  const seen = new Set<string>();

  return getNextTransitions(snapshot).flatMap((transitionDefinition) => {
    const eventType = transitionDefinition.eventType;

    if (
      !eventType
      || eventType === '*'
      || eventType.startsWith('xstate.')
      || (allowedEvents && !allowedEvents.has(eventType))
      || seen.has(eventType)
    ) {
      return [];
    }

    seen.add(eventType);
    return [{
      type: eventType,
      toolName: `${EVENT_TOOL_PREFIX}${eventType}` as const,
      ...((options.events ?? options.schemas?.events)?.[eventType]
        ? { inputSchema: (options.events ?? options.schemas?.events)![eventType] }
        : {}),
    }];
  });
}

export function getEventTools(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentEffectOptions, 'events' | 'schemas'> & {
    allowedEvents?: readonly string[];
  } = {}
): AgentTools {
  return Object.fromEntries(
    getAvailableEvents(snapshot, options).map((event) => [
      event.toolName,
      {
        description: `Transition with event '${event.type}'.`,
        ...(event.inputSchema ? { inputSchema: event.inputSchema } : {}),
        execute: async (input: unknown = {}) => ({
          ...(input && typeof input === 'object' ? input : {}),
          type: event.type,
        }),
      },
    ])
  );
}

export function getAgentEffects(
  actions: readonly { type?: string; params?: unknown }[],
  options: AgentEffectOptions = {}
): AgentEffect[] {
  return actions.flatMap((action) => {
    if (action.type !== 'xstate.spawnChild') {
      return [];
    }

    const params = action.params as
      | { id?: unknown; src?: unknown; input?: unknown }
      | undefined;
    if (!params || typeof params.src !== 'string') {
      return [];
    }

    if (typeof params.id !== 'string' || params.id.length === 0) {
      throw new Error(
        `Agent invoke '${params.src}' must define a durable string id.`
      );
    }

    const textLogic = options.actors?.[params.src];
    const input = isAgentEffectSource(params.src)
      ? params.input as AgentTextInput
      : isTextLogic(textLogic)
        ? textLogic.request(params.input as never)
        : undefined;

    if (!input) {
      return [];
    }

    const events = options.snapshot
      ? getAvailableEvents(options.snapshot, {
        events: options.events,
        schemas: options.schemas,
        allowedEvents: input.allowedEvents,
      })
      : [];
    const eventTools = Object.fromEntries(
      events.map((event) => [
        event.toolName,
        {
          description: `Transition with event '${event.type}'.`,
          ...(event.inputSchema ? { inputSchema: event.inputSchema } : {}),
          execute: async (toolInput: unknown = {}) => ({
            ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
            type: event.type,
          }),
        },
      ])
    );

    return [{
      id: params.id,
      src: params.src,
      ...(isAgentTaskLogic(textLogic) ? { kind: textLogic.taskKind } : {}),
      input,
      tools: {
        ...(input.tools ?? {}),
        ...eventTools,
      },
      events,
    }];
  });
}

export function doneEvent(
  effect: Pick<AgentEffect, 'id'> | string,
  output: unknown
): { type: `xstate.done.actor.${string}`; output: unknown } {
  const id = typeof effect === 'string' ? effect : effect.id;
  return { type: `xstate.done.actor.${id}`, output };
}

export function transitionResult<TLogic extends AnyActorLogic>(
  logic: TLogic,
  snapshot: SnapshotFrom<TLogic>,
  effect: Pick<AgentEffect, 'id'> | string,
  output: unknown
): [SnapshotFrom<TLogic>, ExecutableActionsFrom<TLogic>[]] {
  return transition(logic, snapshot, doneEvent(effect, output) as never);
}

export type AgentTaskExecutor = (
  request: AgentTextInput & { tools: AgentTools }
) => PromiseLike<unknown> | unknown;

export interface AgentTaskExecutors {
  generateText: AgentTaskExecutor;
  streamText?: AgentTaskExecutor;
}

export type AgentMachine<TMachine extends AnyActorLogic = any> =
  TMachine & {
  provide: (...args: any[]) => AgentMachine<TMachine>;
  getTasks(
    actions: readonly { type?: string; params?: unknown }[],
    snapshot?: AnyMachineSnapshot
  ): AgentTask[];
  execute(task: AgentTask, executors: AgentTaskExecutors): Promise<unknown>;
};

async function normalizeTaskExecutionResult(result: unknown): Promise<unknown> {
  const resolved = await result;

  if (!resolved || typeof resolved !== 'object') {
    return resolved;
  }

  if ('toolResults' in resolved && Array.isArray(resolved.toolResults)) {
    const toolOutput = resolved.toolResults.find(
      (toolResult) =>
        toolResult
        && typeof toolResult === 'object'
        && 'output' in toolResult
    )?.output;

    if (toolOutput !== undefined) {
      return toolOutput;
    }
  }

  if ('object' in resolved) {
    return await resolved.object;
  }

  if ('output' in resolved) {
    return await resolved.output;
  }

  if ('text' in resolved) {
    return await resolved.text;
  }

  return resolved;
}

function createAgentMachine<TMachine extends AnyActorLogic>(
  machine: TMachine,
  options: Pick<AgentEffectOptions, 'schemas' | 'actors'>
): AgentMachine<TMachine> {
  return Object.assign(machine, {
    getTasks(
      actions: readonly { type?: string; params?: unknown }[],
      snapshot?: AnyMachineSnapshot
    ) {
      return getAgentEffects(actions, {
        ...options,
        snapshot,
      });
    },
    async execute(task: AgentTask, executors: AgentTaskExecutors) {
      const request = {
        ...task.input,
        tools: task.tools,
      };
      const executor =
        task.kind === 'stream'
          ? executors.streamText
          : executors.generateText;

      if (!executor) {
        throw new Error(
          `No executor provided for ${task.kind === 'stream' ? 'stream' : 'generate'} task '${task.id}'.`
        );
      }

      return normalizeTaskExecutionResult(await executor(request));
    },
  }) as AgentMachine<TMachine>;
}

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
  [K in keyof TActors]: TActors[K] extends PromiseActorLogic<infer TOutput, infer TInput>
    ? PromiseActorLogic<TOutput, TInput>
    : TActors[K];
};
type AgentSetupActors<TActors extends { [K in keyof TActors]: AnyActorLogic }> =
  SetupActors<TActors> & BuiltinTextActors;

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

type AgentTaskEvents<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
  TInputSchema extends StandardSchemaV1,
> =
  | readonly (keyof TEventSchemas & string)[]
  | ((args: {
      input: InferOutput<TInputSchema>;
      schemas: TSchemas;
    }) => readonly (keyof TEventSchemas & string)[]);

export type AgentTaskConfig<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = unknown,
> = Omit<
  TextLogicConfig<TInputSchema, TOutputSchema, TMetadata>,
  'allowedEvents'
> & {
  kind?: AgentTaskKind;
  events?: AgentTaskEvents<TEventSchemas, TSchemas, TInputSchema>;
};

type AgentTaskSchemaMap = Record<
  string,
  {
    input: StandardSchemaV1;
    output: StandardSchemaV1;
  }
>;

type AgentTaskInput<
  TTaskSchemas extends AgentTaskSchemaMap,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
> = {
  [K in keyof TTaskSchemas]: AgentTaskConfig<
    TEventSchemas,
    TSchemas,
    TTaskSchemas[K]['input'],
    TTaskSchemas[K]['output']
  > & {
    schemas: TTaskSchemas[K];
    allowedEvents?: never;
  };
};

type TaskActors<TTaskSchemas extends AgentTaskSchemaMap> = {
  [K in keyof TTaskSchemas]: AgentTaskLogic<
    TTaskSchemas[K]['input'],
    TTaskSchemas[K]['output']
  >;
};

type AgentSetupConfigOptions<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TActions extends Record<string, ParameterizedObject['params'] | undefined>,
  TGuards extends Record<string, ParameterizedObject['params'] | undefined>,
  TDelay extends string,
> = Parameters<
  typeof setup<
    ContextOf<TContextSchema>,
    EventsOf<TEventSchemas>,
    AgentSetupActors<TActors>,
    {},
    TActions,
    TGuards,
    TDelay,
    string,
    InferOutput<TInputSchema>,
    Constrain<InferOutput<TOutputSchema>, NonReducibleUnknown>,
    EventObject,
    MetaOf<TMetaSchema>
  >
>[0];

type SetupAgentBaseConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TActions extends Record<string, ParameterizedObject['params'] | undefined>,
  TGuards extends Record<string, ParameterizedObject['params'] | undefined>,
  TDelay extends string,
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
  actors?: TActors;
  actions?: AgentSetupConfigOptions<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay
  >['actions'];
  guards?: AgentSetupConfigOptions<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay
  >['guards'];
  delays?: AgentSetupConfigOptions<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay
  >['delays'];
};

type SetupAgentXStateResult<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TActions extends Record<string, ParameterizedObject['params'] | undefined>,
  TGuards extends Record<string, ParameterizedObject['params'] | undefined>,
  TDelay extends string,
> = ReturnType<
  typeof setup<
    ContextOf<TContextSchema>,
    EventsOf<TEventSchemas>,
    AgentSetupActors<TActors>,
    {},
    TActions,
    TGuards,
    TDelay,
    string,
    InferOutput<TInputSchema>,
    Constrain<InferOutput<TOutputSchema>, NonReducibleUnknown>,
    EventObject,
    MetaOf<TMetaSchema>
  >
>;

type SetupAgentResult<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TActions extends Record<string, ParameterizedObject['params'] | undefined>,
  TGuards extends Record<string, ParameterizedObject['params'] | undefined>,
  TDelay extends string,
  TTasks extends { [K in keyof TTasks]: AgentTaskLogic } = {},
> = Omit<
  SetupAgentXStateResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay
  >,
  'createMachine'
> & {
  createMachine: <
    const TConfig extends Parameters<
      SetupAgentXStateResult<
        TContextSchema,
        TEventSchemas,
        TActors,
        TInputSchema,
        TOutputSchema,
        TMetaSchema,
        TActions,
        TGuards,
        TDelay
      >['createMachine']
    >[0],
  >(
    config: TConfig
  ) => any;
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
  >;
  tasks: TTasks;
  withTasks<const TNextTaskSchemas extends AgentTaskSchemaMap>(
    tasks: AgentTaskInput<
      TNextTaskSchemas,
      TEventSchemas,
      AgentSchemaPack<
        TContextSchema,
        TEventSchemas,
        TInputSchema,
        TOutputSchema,
        TMetaSchema
      >
    >
  ): SetupAgentResult<
    TContextSchema,
    TEventSchemas,
    TActors & TaskActors<TNextTaskSchemas>,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay,
    TTasks & TaskActors<TNextTaskSchemas>
  >;
};

/**
 * Schema-first `setup(...)` for agent machines. Context, events, machine
 * input, machine output, and state/transition meta are all standard
 * schemas — no `{} as Type` casts — and are retained on `result.schemas`
 * for runtime validation. Registers the well-known `agent.generate`
 * and `agent.stream` actors so machines can invoke them with plain
 * XState config.
 */
export function setupAgent<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetaSchema extends StandardSchemaV1 = StandardSchemaV1<MetaObject>,
  TActions extends Record<string, ParameterizedObject['params'] | undefined> = {},
  TGuards extends Record<string, ParameterizedObject['params'] | undefined> = {},
  TDelay extends string = never,
>(
  config: SetupAgentBaseConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay
  >
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TActions,
  TGuards,
  TDelay,
  {}
> {
  return createSetupAgent(config, {});
}

function createTaskActors<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
  TTaskSchemas extends AgentTaskSchemaMap,
>(schemas: TSchemas, tasks: AgentTaskInput<TTaskSchemas, TEventSchemas, TSchemas>): TaskActors<TTaskSchemas> {
  return Object.fromEntries(
    Object.entries(tasks).map(([key, task]) => {
      const logic = createTextLogic({
        ...task,
        allowedEvents: task.events
          ? ({ input }) =>
              typeof task.events === 'function'
                ? task.events({ input, schemas })
                : task.events
          : undefined,
      } as TextLogicConfig<StandardSchemaV1, StandardSchemaV1>);

      return [
        key,
        Object.assign(logic, {
          taskKind: task.kind ?? 'generate',
        }),
      ];
    })
  ) as TaskActors<TTaskSchemas>;
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

function createSetupAgent<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TActions extends Record<string, ParameterizedObject['params'] | undefined>,
  TGuards extends Record<string, ParameterizedObject['params'] | undefined>,
  TDelay extends string,
  TTasks extends { [K in keyof TTasks]: AgentTaskLogic },
>(
  config: SetupAgentBaseConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay
  >,
  tasks: TTasks
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TInputSchema,
  TOutputSchema,
  TMetaSchema,
  TActions,
  TGuards,
  TDelay,
  TTasks
> {
  const schemas = normalizeAgentSchemas(config);
  const base = setup<
    ContextOf<TContextSchema>,
    EventsOf<TEventSchemas>,
    AgentSetupActors<TActors>,
    {},
    TActions,
    TGuards,
    TDelay,
    string,
    InferOutput<TInputSchema>,
    Constrain<InferOutput<TOutputSchema>, NonReducibleUnknown>,
    EventObject,
    MetaOf<TMetaSchema>
  >({
    types: {} as {
      context: ContextOf<TContextSchema>;
      events: EventsOf<TEventSchemas>;
      input: InferOutput<TInputSchema>;
      output: Constrain<InferOutput<TOutputSchema>, NonReducibleUnknown>;
      meta: MetaOf<TMetaSchema>;
    },
    actors: {
      ...config.actors,
      [AGENT_GENERATE_SRC]: missingHostActor(AGENT_GENERATE_SRC),
      [AGENT_STREAM_SRC]: missingHostActor(AGENT_STREAM_SRC),
    } as AgentSetupConfigOptions<
      TContextSchema,
      TEventSchemas,
      TActors,
      TInputSchema,
      TOutputSchema,
      TMetaSchema,
      TActions,
      TGuards,
      TDelay
    >['actors'],
    actions: config.actions,
    guards: config.guards,
    delays: config.delays,
  });
  const createBaseMachine = base.createMachine.bind(base);

  return Object.assign(base, {
    createMachine(machineConfig: Parameters<typeof base.createMachine>[0]) {
      return createAgentMachine(createBaseMachine(machineConfig as never), {
        schemas,
        actors: {
          ...config.actors,
          ...tasks,
        },
      });
    },
    schemas,
    tasks,
    withTasks<const TNextTaskSchemas extends AgentTaskSchemaMap>(
      nextTasks: AgentTaskInput<TNextTaskSchemas, TEventSchemas, typeof schemas>
    ) {
      const taskActors = createTaskActors(schemas, nextTasks) as TaskActors<TNextTaskSchemas>;
      return createSetupAgent({
        ...config,
        schemas,
        actors: {
          ...config.actors,
          ...taskActors,
        } as TActors & TaskActors<TNextTaskSchemas>,
      }, {
        ...tasks,
        ...taskActors,
      } as TTasks & TaskActors<TNextTaskSchemas>);
    },
  }) as unknown as SetupAgentResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TActions,
    TGuards,
    TDelay,
    TTasks
  >;
}
