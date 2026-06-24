import {
  fromPromise,
  getNextTransitions,
  initialTransition,
  setup,
  transition,
  assign,
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

const USER_INPUT_ACTOR = 'agent.userInput' as const;
const GENERATE_TEXT_ACTOR = 'agent.generateText' as const;
const STREAM_TEXT_ACTOR = 'agent.streamText' as const;

export type AgentTaskKind = 'generate' | 'stream';

/** Portable LCD input text tasks pass to host executors. */
export interface AgentTextInput<TMetadata = Record<string, unknown>> {
  model: string;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  /** Host/model tools that are always available to this text call. */
  tools?: AgentTools;
  toolChoice?: AgentToolChoice;
  /** Machine event types to expose as model-call tools for this state. */
  eventTypes?: readonly string[];
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

export interface AgentUserInput<TMetadata = Record<string, unknown>> {
  prompt?: string;
  schema?: StandardSchemaV1;
  metadata?: TMetadata;
}

type BuiltinAgentActors = {
  [GENERATE_TEXT_ACTOR]: PromiseActorLogic<unknown, AgentTextInput>;
  [STREAM_TEXT_ACTOR]: PromiseActorLogic<unknown, AgentTextInput>;
  [USER_INPUT_ACTOR]: PromiseActorLogic<unknown, AgentUserInput>;
};

const agentTextInputSchema: StandardSchemaV1<AgentTextInput> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      const ok =
        !!value
        && typeof value === 'object'
        && typeof (value as AgentTextInput).model === 'string';

      return ok
        ? { value: value as AgentTextInput }
        : { issues: [{ message: 'Expected agent text input with a model' }] };
    },
  },
};

const unknownOutputSchema: StandardSchemaV1<unknown> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      return { value };
    },
  },
};

const stringOutputSchema: StandardSchemaV1<string> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      return typeof value === 'string'
        ? { value }
        : { issues: [{ message: 'Expected string output' }] };
    },
  },
};

function createBuiltinTextActor(
  src: typeof GENERATE_TEXT_ACTOR | typeof STREAM_TEXT_ACTOR,
  taskKind: AgentTaskKind,
  outputSchema: StandardSchemaV1
): AgentTaskLogic<StandardSchemaV1<AgentTextInput>, StandardSchemaV1> {
  const logic = fromPromise<unknown, AgentTextInput>(async () => {
    throw new Error(
      `'${src}' has no host execution. Provide an implementation with ` +
        `machine.provide({ actors: { '${src}': ... } }) or execute the ` +
        `returned agent task with machine.execute(...).`
    );
  });

  return Object.assign(logic, {
    kind: 'statelyai.textLogic' as const,
    taskKind,
    schemas: {
      input: agentTextInputSchema,
      output: outputSchema,
    },
    request(input: AgentTextInput) {
      return validateSchemaSync(agentTextInputSchema, input);
    },
    async execute(input: AgentTextInput, executors: AgentTaskExecutors) {
      const output = await executeAgentTextRequest(
        taskKind,
        src,
        validateSchemaSync(agentTextInputSchema, input),
        executors
      );

      return validateSchemaSync(outputSchema, output);
    },
    withExecutor(
      execute: TextLogicExecutor<
        StandardSchemaV1<AgentTextInput>,
        StandardSchemaV1<unknown>,
        Record<string, unknown>
      >
    ) {
      return Object.assign(createTextLogic({
        kind: taskKind,
        schemas: {
          input: agentTextInputSchema,
          output: outputSchema,
        },
        model: ({ input }) => input.model,
        system: ({ input }) => input.system,
        prompt: ({ input }) => input.prompt,
        messages: ({ input }) => input.messages,
        tools: ({ input }) => input.tools,
        toolChoice: ({ input }) => input.toolChoice,
        events: ({ input }) => input.eventTypes,
        temperature: ({ input }) => input.temperature,
        maxTokens: ({ input }) => input.maxTokens,
        topP: ({ input }) => input.topP,
        topK: ({ input }) => input.topK,
        seed: ({ input }) => input.seed,
        stopSequences: ({ input }) => input.stopSequences,
        metadata: ({ input }) => input.metadata,
      }, execute), { taskKind });
    },
  }) as AgentTaskLogic<
    StandardSchemaV1<AgentTextInput>,
    StandardSchemaV1
  >;
}

const builtinTextActors = {
  [GENERATE_TEXT_ACTOR]: createBuiltinTextActor(
    GENERATE_TEXT_ACTOR,
    'generate',
    unknownOutputSchema
  ),
  [STREAM_TEXT_ACTOR]: createBuiltinTextActor(
    STREAM_TEXT_ACTOR,
    'stream',
    stringOutputSchema
  ),
} satisfies Pick<
  BuiltinAgentActors,
  typeof GENERATE_TEXT_ACTOR | typeof STREAM_TEXT_ACTOR
>;

const userInputActor = fromPromise<unknown, AgentUserInput>(async () => {
  throw new Error(
    `'${USER_INPUT_ACTOR}' has no host execution. Provide an implementation ` +
      `with machine.provide({ actors: { '${USER_INPUT_ACTOR}': ... } }).`
  );
});

function missingActor(src: string): PromiseActorLogic<unknown, unknown> {
  return fromPromise<unknown, unknown>(async () => {
    throw new Error(
      `'${src}' has no host execution. Provide an implementation with ` +
        `machine.provide({ actors: { '${src}': ... } }).`
    );
  });
}

type JsonSchemaObject = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: unknown;
  [key: string]: unknown;
};

function jsonSchemaToStandardSchema<T = unknown>(
  schema: JsonSchemaObject | undefined,
  name = 'schema'
): StandardSchemaV1<T> {
  const resolvedSchema = schema ?? {};

  return {
    '~standard': {
      version: 1,
      vendor: 'statelyai-agent-json-schema',
      validate(value: unknown) {
        const issues: { message: string }[] = [];
        validateJsonSchemaValue(resolvedSchema, value, name, issues);
        return issues.length > 0 ? { issues } : { value: value as T };
      },
    },
  };
}

function validateJsonSchemaValue(
  schema: JsonSchemaObject,
  value: unknown,
  path: string,
  issues: { message: string }[]
) {
  if (schema.const !== undefined && value !== schema.const) {
    issues.push({ message: `${path} must equal ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.enum && !schema.enum.some((item) => item === value)) {
    issues.push({ message: `${path} must be one of ${schema.enum.join(', ')}` });
    return;
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (!type) {
    return;
  }

  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ message: `${path} must be an object` });
      return;
    }

    const objectValue = value as Record<string, unknown>;
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in objectValue)) {
        issues.push({ message: `${path}.${requiredKey} is required` });
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in objectValue) {
        validateJsonSchemaValue(
          propertySchema,
          objectValue[key],
          `${path}.${key}`,
          issues
        );
      }
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ message: `${path} must be an array` });
      return;
    }

    if (schema.items) {
      value.forEach((item, index) =>
        validateJsonSchemaValue(schema.items!, item, `${path}[${index}]`, issues)
      );
    }
    return;
  }

  const ok =
    (type === 'string' && typeof value === 'string')
    || (type === 'number' && typeof value === 'number')
    || (type === 'integer' && Number.isInteger(value))
    || (type === 'boolean' && typeof value === 'boolean')
    || (type === 'null' && value === null);

  if (!ok) {
    issues.push({ message: `${path} must be ${type}` });
  }
}

const wholeExpressionPattern = /^\{\{\s*([\s\S]*?)\s*\}\}$/;
const templateExpressionPattern = /\{\{\s*([\s\S]*?)\s*\}\}/g;

type ExpressionScope = {
  context?: unknown;
  event?: unknown;
  input?: unknown;
  output?: unknown;
};

function evaluatePathExpression(expression: string, scope: ExpressionScope): unknown {
  const parts = expression.trim().split('.').filter(Boolean);
  let current: unknown = scope;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function evaluateExpressionValue(value: unknown, scope: ExpressionScope): unknown {
  if (typeof value === 'string') {
    const wholeMatch = value.match(wholeExpressionPattern);
    if (wholeMatch?.[1]) {
      return evaluatePathExpression(wholeMatch[1], scope);
    }

    return value.replace(templateExpressionPattern, (_match, expression: string) => {
      const resolved = evaluatePathExpression(expression, scope);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => evaluateExpressionValue(item, scope));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        evaluateExpressionValue(item, scope),
      ])
    );
  }

  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}


// ─── Message helpers ───
//
// Messages are plain context state: declare a `messages` field in the
// context schema and update it with `appendMessages(...)`:
//
//   actions: appendMessages(({ event }) => userMessage(event.prompt))

export {
  assistantMessage,
  systemMessage,
  userMessage,
  validateSchemaSync,
} from './utils.js';

function addMessages<
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

export function appendMessages<
  TContext extends { messages: AgentMessage[] },
  TEvent extends EventObject,
>(
  resolve:
    | AgentMessage
    | AgentMessage[]
    | ((args: { context: TContext; event: TEvent }) => AgentMessage | AgentMessage[]),
) {
  return assign({
    messages: addMessages(resolve),
  }) as never;
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
  TMetadata = Record<string, unknown>,
> {
  kind?: AgentTaskKind;
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
  events?: ResolveTextLogicValue<
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

export interface TextLogicExecuteArgs<TInput, TMetadata = Record<string, unknown>> {
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
  TMetadata = Record<string, unknown>,
> extends PromiseActorLogic<
    InferOutput<TOutputSchema>,
    InferOutput<TInputSchema>
  > {
  readonly kind: 'statelyai.textLogic';
  readonly taskKind: AgentTaskKind;
  readonly schemas: {
    readonly input: TInputSchema;
    readonly output: TOutputSchema;
  };
  request(input: InferOutput<TInputSchema>): AgentTextInput<TMetadata>;
  execute(
    input: InferOutput<TInputSchema>,
    executors: AgentTaskExecutors
  ): Promise<InferOutput<TOutputSchema>>;
  withExecutor(
    execute: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>
  ): TextLogic<TInputSchema, TOutputSchema, TMetadata>;
}

export interface AgentTaskLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = Record<string, unknown>,
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
  TMetadata = Record<string, unknown>,
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
      eventTypes: resolveTextLogicValue(config.events, args),
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
    taskKind: config.kind ?? 'generate',
    schemas: config.schemas,
    request,
    async execute(input: TInput, executors: AgentTaskExecutors) {
      const output = await executeAgentTextRequest(
        config.kind ?? 'generate',
        'textLogic',
        request(input),
        executors
      );

      return validateSchemaSync<TOutput>(
        config.schemas.output as StandardSchemaV1<TOutput>,
        output
      );
    },
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

export type AgentEffectSource = string & {};

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

export function getAvailableEvents(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentEffectOptions, 'events' | 'schemas'> & {
    eventTypes?: readonly string[];
  } = {}
): AgentEventDescriptor[] {
  const eventTypes =
    options.eventTypes === undefined
      ? undefined
      : new Set(options.eventTypes);
  const seen = new Set<string>();

  return getNextTransitions(snapshot).flatMap((transitionDefinition) => {
    const eventType = transitionDefinition.eventType;

    if (
      !eventType
      || eventType === '*'
      || eventType.startsWith('xstate.')
      || (eventTypes && !eventTypes.has(eventType))
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
    eventTypes?: readonly string[];
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
    const input = isTextLogic(textLogic)
      ? textLogic.request(params.input as never)
      : undefined;

    if (!input) {
      return [];
    }

    const events = options.snapshot
      ? getAvailableEvents(options.snapshot, {
        events: options.events,
        schemas: options.schemas,
        eventTypes: input.eventTypes,
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

export interface AgentStep<TSnapshot extends AnyMachineSnapshot = AnyMachineSnapshot> {
  snapshot: TSnapshot;
  actions: readonly { type?: string; params?: unknown }[];
  tasks: AgentTask[];
  done: boolean;
}

export type AgentMachine<TMachine extends AnyActorLogic = any> =
  TMachine & {
  provide: (...args: any[]) => AgentMachine<TMachine>;
  initial(input?: unknown): AgentStep<SnapshotFrom<TMachine>>;
  transition(
    snapshotOrStep: SnapshotFrom<TMachine> | AgentStep<SnapshotFrom<TMachine>>,
    event: EventObject
  ): AgentStep<SnapshotFrom<TMachine>>;
  resolve(
    step: AgentStep<SnapshotFrom<TMachine>>,
    task: Pick<AgentEffect, 'id'> | string,
    output: unknown
  ): AgentStep<SnapshotFrom<TMachine>>;
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

async function executeAgentTextRequest(
  taskKind: AgentTaskKind,
  id: string,
  input: AgentTextInput<any>,
  executors: AgentTaskExecutors,
  tools: AgentTools = {}
): Promise<unknown> {
  const request = {
    ...input,
    tools: {
      ...(input.tools ?? {}),
      ...tools,
    },
  };
  const executor =
    taskKind === 'stream'
      ? executors.streamText
      : executors.generateText;

  if (!executor) {
    throw new Error(
      `No executor provided for ${taskKind === 'stream' ? 'stream' : 'generate'} task '${id}'.`
    );
  }

  return normalizeTaskExecutionResult(await executor(request));
}

function createAgentMachine<TMachine extends AnyActorLogic>(
  machine: TMachine,
  options: Pick<AgentEffectOptions, 'schemas' | 'actors'>
): AgentMachine<TMachine> {
  const originalTransition = machine.transition.bind(machine);
  const originalProvide = 'provide' in machine
    ? (machine.provide as (...args: any[]) => TMachine).bind(machine)
    : undefined;
  const agentMachine = Object.assign(machine, {
    provide(...args: any[]) {
      if (!originalProvide) {
        throw new Error('This actor logic does not support provide(...).');
      }

      return createAgentMachine(originalProvide(...args), options);
    },
    initial(input?: unknown) {
      const [snapshot, actions] = initialTransition(agentMachine, input as never);
      return createAgentStep(agentMachine, snapshot, actions);
    },
    transition(
      snapshotOrStep: SnapshotFrom<TMachine> | AgentStep<SnapshotFrom<TMachine>>,
      event: EventObject,
      actorScope?: unknown
    ) {
      if (actorScope !== undefined) {
        return originalTransition(snapshotOrStep as never, event as never, actorScope as never);
      }

      const snapshot = isAgentStep(snapshotOrStep)
        ? snapshotOrStep.snapshot
        : snapshotOrStep;
      const [nextSnapshot, actions] = transition(agentMachine, snapshot, event as never);
      return createAgentStep(agentMachine, nextSnapshot, actions);
    },
    resolve(
      step: AgentStep<SnapshotFrom<TMachine>>,
      task: Pick<AgentEffect, 'id'> | string,
      output: unknown
    ) {
      const [snapshot, actions] = transitionResult(agentMachine, step.snapshot, task, output);
      return createAgentStep(agentMachine, snapshot, actions);
    },
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
      const output = await executeAgentTextRequest(
        task.kind ?? 'generate',
        task.id,
        task.input,
        executors,
        task.tools
      );

      return task.input.outputSchema
        ? validateSchemaSync(task.input.outputSchema, output)
        : output;
    },
  }) as unknown as AgentMachine<TMachine>;

  return agentMachine;
}

function createAgentStep<TMachine extends AnyActorLogic>(
  machine: AgentMachine<TMachine>,
  snapshot: SnapshotFrom<TMachine>,
  actions: readonly { type?: string; params?: unknown }[]
): AgentStep<SnapshotFrom<TMachine>> {
  return {
    snapshot,
    actions,
    tasks: machine.getTasks(actions, snapshot),
    done: (snapshot as AnyMachineSnapshot).status === 'done',
  };
}

function isAgentStep<TSnapshot extends AnyMachineSnapshot>(
  value: unknown
): value is AgentStep<TSnapshot> {
  return (
    !!value
    && typeof value === 'object'
    && 'snapshot' in value
    && 'actions' in value
    && 'tasks' in value
  );
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
  TActors & BuiltinAgentActors;

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
  TMetadata = Record<string, unknown>,
> = Omit<
  TextLogicConfig<TInputSchema, TOutputSchema, TMetadata>,
  'events'
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
    eventTypes?: never;
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
    SetupActors<AgentSetupActors<TActors>>,
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
    SetupActors<AgentSetupActors<TActors>>,
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
  ) => AgentMachine<any>;
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
  >;
  tasks: TTasks;
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
 * for runtime validation.
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

export interface AgentWorkflowConfig {
  key?: string;
  id?: string;
  version?: string;
  description?: string;
  schemas?: {
    input?: JsonSchemaObject;
    context?: JsonSchemaObject;
    events?: Record<string, JsonSchemaObject>;
    output?: JsonSchemaObject;
    meta?: JsonSchemaObject;
  };
  context?: Record<string, unknown>;
  tasks?: Record<string, AgentWorkflowTaskConfig>;
  actors?: Record<string, AgentWorkflowActorConfig>;
  initial: string;
  states: Record<string, AgentWorkflowStateConfig>;
  meta?: Record<string, unknown>;
}

export interface AgentWorkflowTaskConfig {
  kind?: AgentTaskKind;
  description?: string;
  model: unknown;
  system?: unknown;
  prompt?: unknown;
  messages?: unknown;
  input: JsonSchemaObject;
  output: JsonSchemaObject;
  events?: unknown;
  tools?: AgentTools;
  toolChoice?: AgentToolChoice | unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  topP?: unknown;
  topK?: unknown;
  seed?: unknown;
  stopSequences?: unknown;
  metadata?: unknown;
}

export interface AgentWorkflowActorConfig {
  input?: JsonSchemaObject;
  output?: JsonSchemaObject;
  description?: string;
}

export interface AgentWorkflowStateConfig {
  description?: string;
  type?: 'parallel' | 'history' | 'final';
  initial?: string;
  states?: Record<string, AgentWorkflowStateConfig>;
  invoke?: AgentWorkflowInvokeConfig | AgentWorkflowInvokeConfig[];
  on?: Record<string, AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[]>;
  always?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  onDone?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  after?: Record<string, AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[]>;
  entry?: AgentWorkflowActionConfig | AgentWorkflowActionConfig[];
  exit?: AgentWorkflowActionConfig | AgentWorkflowActionConfig[];
  tags?: string[];
  output?: unknown;
  meta?: Record<string, unknown>;
}

export interface AgentWorkflowInvokeConfig {
  id?: string;
  src: string;
  input?: unknown;
  onDone?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  onError?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  meta?: Record<string, unknown>;
}

export interface AgentWorkflowTransitionConfig {
  target?: string | string[];
  guard?: unknown;
  assign?: Record<string, unknown>;
  actions?: AgentWorkflowActionConfig | AgentWorkflowActionConfig[];
  description?: string;
  reenter?: boolean;
  meta?: Record<string, unknown>;
}

export interface AgentWorkflowActionConfig {
  type: string;
  params?: unknown;
  assign?: Record<string, unknown>;
  [key: string]: unknown;
}

function createSchemasFromWorkflowConfig(
  config: AgentWorkflowConfig
): AgentSchemaPack<
  StandardSchemaV1<Record<string, unknown>>,
  Record<string, StandardSchemaV1>,
  StandardSchemaV1,
  StandardSchemaV1,
  StandardSchemaV1<MetaObject>
> {
  return createAgentSchemas({
    context: jsonSchemaToStandardSchema<Record<string, unknown>>(
      config.schemas?.context ?? { type: 'object' },
      'context'
    ),
    events: Object.fromEntries(
      Object.entries(config.schemas?.events ?? {}).map(([key, schema]) => [
        key,
        jsonSchemaToStandardSchema(schema, `event.${key}`),
      ])
    ),
    input: jsonSchemaToStandardSchema(config.schemas?.input, 'input'),
    output: jsonSchemaToStandardSchema(config.schemas?.output, 'output'),
    meta: jsonSchemaToStandardSchema<MetaObject>(config.schemas?.meta, 'meta'),
  });
}

function createTasksFromWorkflowConfig(
  config: AgentWorkflowConfig
): AgentTaskInput<
  Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>,
  Record<string, StandardSchemaV1>,
  AgentSchemaPack<any, Record<string, StandardSchemaV1>, any, any, any>
> {
  return Object.fromEntries(
    Object.entries(config.tasks ?? {}).map(([key, task]) => [
      key,
      {
        kind: task.kind,
        description: task.description,
        schemas: {
          input: jsonSchemaToStandardSchema(task.input, `${key}.input`),
          output: jsonSchemaToStandardSchema(task.output, `${key}.output`),
        },
        model: ({ input }) =>
          String(evaluateExpressionValue(task.model, { input }) ?? ''),
        system: task.system === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.system, { input }) as string | undefined,
        prompt: task.prompt === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.prompt, { input }) as string | undefined,
        messages: task.messages === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.messages, { input }) as
                | AgentMessage[]
                | undefined,
        tools: task.tools,
        toolChoice: task.toolChoice as AgentToolChoice | undefined,
        events: task.events === undefined
          ? undefined
          : ({ input }) => {
              const events = evaluateExpressionValue(task.events, { input });
              return Array.isArray(events)
                ? events.filter((event): event is string => typeof event === 'string')
                : [];
            },
        temperature: task.temperature === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.temperature, { input }) as
                | number
                | undefined,
        maxTokens: task.maxTokens === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.maxTokens, { input }) as number | undefined,
        topP: task.topP === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.topP, { input }) as number | undefined,
        topK: task.topK === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.topK, { input }) as number | undefined,
        seed: task.seed === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.seed, { input }) as number | undefined,
        stopSequences: task.stopSequences === undefined
          ? undefined
          : ({ input }) =>
              evaluateExpressionValue(task.stopSequences, { input }) as
                | string[]
                | undefined,
        metadata: task.metadata === undefined
          ? undefined
          : ({ input }) => evaluateExpressionValue(task.metadata, { input }),
      },
    ])
  ) as AgentTaskInput<
    Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>,
    Record<string, StandardSchemaV1>,
    AgentSchemaPack<any, Record<string, StandardSchemaV1>, any, any, any>
  >;
}

function createActorPlaceholdersFromWorkflowConfig(config: AgentWorkflowConfig) {
  return Object.fromEntries(
    Object.keys(config.actors ?? {}).map((key) => [key, missingActor(key)])
  ) as Record<string, PromiseActorLogic<unknown, unknown>>;
}

function createAssignAction(assignConfig: Record<string, unknown>) {
  return assign(
    Object.fromEntries(
      Object.entries(assignConfig).map(([key, value]) => [
        key,
        ({ context, event }: { context: unknown; event: unknown }) =>
          evaluateExpressionValue(value, { context, event }),
      ])
    ) as never
  );
}

function lowerWorkflowActions(
  actionConfig: AgentWorkflowActionConfig | AgentWorkflowActionConfig[] | undefined
) {
  if (!actionConfig) {
    return undefined;
  }

  const actions = Array.isArray(actionConfig) ? actionConfig : [actionConfig];
  return actions.map((action) =>
    action.assign
      ? createAssignAction(action.assign)
      : {
          type: action.type,
          params: ({ context, event }: { context: unknown; event: unknown }) =>
            evaluateExpressionValue(action.params, { context, event }),
        }
  );
}

function lowerWorkflowTransition(
  transitionConfig: AgentWorkflowTransitionConfig
) {
  const actions = [
    ...(transitionConfig.assign ? [createAssignAction(transitionConfig.assign)] : []),
    ...(lowerWorkflowActions(transitionConfig.actions) ?? []),
  ];

  return {
    ...(transitionConfig.target !== undefined
      ? { target: transitionConfig.target }
      : {}),
    ...(transitionConfig.guard !== undefined
      ? {
          guard:
            typeof transitionConfig.guard === 'string'
              ? ({ context, event }: { context: unknown; event: unknown }) =>
                  Boolean(evaluateExpressionValue(transitionConfig.guard, {
                    context,
                    event,
                  }))
              : transitionConfig.guard,
        }
      : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(transitionConfig.description !== undefined
      ? { description: transitionConfig.description }
      : {}),
    ...(transitionConfig.reenter !== undefined
      ? { reenter: transitionConfig.reenter }
      : {}),
    ...(transitionConfig.meta !== undefined ? { meta: transitionConfig.meta } : {}),
  };
}

function lowerWorkflowTransitionOrArray(
  transitionConfig:
    | AgentWorkflowTransitionConfig
    | AgentWorkflowTransitionConfig[]
    | undefined
) {
  if (!transitionConfig) {
    return undefined;
  }

  return Array.isArray(transitionConfig)
    ? transitionConfig.map(lowerWorkflowTransition)
    : lowerWorkflowTransition(transitionConfig);
}

function lowerWorkflowInvoke(
  invokeConfig: AgentWorkflowInvokeConfig
) {
  return {
    ...(invokeConfig.id !== undefined ? { id: invokeConfig.id } : {}),
    src: invokeConfig.src,
    ...(invokeConfig.input !== undefined
      ? {
          input: ({ context, event }: { context: unknown; event: unknown }) =>
            evaluateExpressionValue(invokeConfig.input, { context, event }),
        }
      : {}),
    ...(invokeConfig.onDone !== undefined
      ? { onDone: lowerWorkflowTransitionOrArray(invokeConfig.onDone) }
      : {}),
    ...(invokeConfig.onError !== undefined
      ? { onError: lowerWorkflowTransitionOrArray(invokeConfig.onError) }
      : {}),
    ...(invokeConfig.meta !== undefined ? { meta: invokeConfig.meta } : {}),
  };
}

function lowerWorkflowState(stateConfig: AgentWorkflowStateConfig): Record<string, unknown> {
  return {
    ...(stateConfig.description !== undefined
      ? { description: stateConfig.description }
      : {}),
    ...(stateConfig.type !== undefined ? { type: stateConfig.type } : {}),
    ...(stateConfig.initial !== undefined ? { initial: stateConfig.initial } : {}),
    ...(stateConfig.states !== undefined
      ? {
          states: Object.fromEntries(
            Object.entries(stateConfig.states).map(([key, child]) => [
              key,
              lowerWorkflowState(child),
            ])
          ),
        }
      : {}),
    ...(stateConfig.invoke !== undefined
      ? {
          invoke: Array.isArray(stateConfig.invoke)
            ? stateConfig.invoke.map(lowerWorkflowInvoke)
            : lowerWorkflowInvoke(stateConfig.invoke),
        }
      : {}),
    ...(stateConfig.on !== undefined
      ? {
          on: Object.fromEntries(
            Object.entries(stateConfig.on).map(([eventType, transitionConfig]) => [
              eventType,
              lowerWorkflowTransitionOrArray(transitionConfig),
            ])
          ),
        }
      : {}),
    ...(stateConfig.always !== undefined
      ? { always: lowerWorkflowTransitionOrArray(stateConfig.always) }
      : {}),
    ...(stateConfig.onDone !== undefined
      ? { onDone: lowerWorkflowTransitionOrArray(stateConfig.onDone) }
      : {}),
    ...(stateConfig.after !== undefined
      ? {
          after: Object.fromEntries(
            Object.entries(stateConfig.after).map(([delay, transitionConfig]) => [
              delay,
              lowerWorkflowTransitionOrArray(transitionConfig),
            ])
          ),
        }
      : {}),
    ...(stateConfig.entry !== undefined
      ? { entry: lowerWorkflowActions(stateConfig.entry) }
      : {}),
    ...(stateConfig.exit !== undefined
      ? { exit: lowerWorkflowActions(stateConfig.exit) }
      : {}),
    ...(stateConfig.tags !== undefined ? { tags: stateConfig.tags } : {}),
    ...(stateConfig.output !== undefined
      ? {
          output: ({ context, event }: { context: unknown; event: unknown }) =>
            evaluateExpressionValue(stateConfig.output, { context, event }),
        }
      : {}),
    ...(stateConfig.meta !== undefined ? { meta: stateConfig.meta } : {}),
  };
}

function setupAgentFromConfig(config: AgentWorkflowConfig): AgentMachine {
  const schemas = createSchemasFromWorkflowConfig(config);
  const tasks = createTasksFromWorkflowConfig(config);
  const taskActors = createTaskActors(schemas, tasks);
  const actors = createActorPlaceholdersFromWorkflowConfig(config);
  const agent = setupAgent({
    schemas,
    actors: {
      ...actors,
      ...taskActors,
    },
  });

  return agent.createMachine({
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.context !== undefined
      ? {
          context: ({ input }: { input: unknown }) =>
            validateSchemaSync(
              schemas.context,
              evaluateExpressionValue(config.context, { input })
            ),
        }
      : {}),
    initial: config.initial,
    states: Object.fromEntries(
      Object.entries(config.states).map(([key, state]) => [
        key,
        lowerWorkflowState(state),
      ])
    ),
    ...(config.meta !== undefined ? { meta: config.meta } : {}),
  } as never);
}

export namespace setupAgent {
  export function fromConfig(config: AgentWorkflowConfig): AgentMachine {
    return setupAgentFromConfig(config);
  }
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
        kind: task.kind ?? 'generate',
        events: task.events
          ? ({ input }) =>
              typeof task.events === 'function'
                ? task.events({ input, schemas })
                : task.events
          : undefined,
      } as TextLogicConfig<StandardSchemaV1, StandardSchemaV1>);

      return [
        key,
        logic,
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
    SetupActors<AgentSetupActors<TActors>>,
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
      ...builtinTextActors,
      [USER_INPUT_ACTOR]: userInputActor,
      ...config.actors,
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
          ...builtinTextActors,
          ...config.actors,
          ...tasks,
        },
      });
    },
    schemas,
    tasks,
    appendMessages(resolve: Parameters<typeof appendMessages>[0]) {
      return appendMessages(resolve as never);
    },
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
