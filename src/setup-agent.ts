import {
  createAsyncLogic,
  getNextTransitions,
  initialTransition,
  setup,
  transition,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyMachineSnapshot,
  type AnySetupConfig,
  type AnyStateMachine,
  type AsyncActorLogic,
  type EnqueueObject,
  type EventObject,
  type EventFromLogic,
  type ExecutableActionObjectFromLogic,
  type MachineContext,
  type MetaObject,
  type NonReducibleUnknown,
  type OutputFrom,
  type SetupConfig,
  type SetupReturnFromConfig,
  type SnapshotFrom,
} from 'xstate';
import type {
  AgentMessage,
  AgentToolChoice,
  AgentTools,
  AllowedEvents,
  ChosenEvent,
  EventUnion,
  InferOutput,
  StandardSchemaV1,
} from './types.js';
import { validateSchemaSync } from './utils.js';

const USER_INPUT_ACTOR = 'agent.userInput' as const;
const GENERATE_TEXT_ACTOR = 'agent.generateText' as const;
const STREAM_TEXT_ACTOR = 'agent.streamText' as const;
const DECIDE_ACTOR = 'agent.decide' as const;

export type AgentRequestMode = 'generate' | 'stream';

/** Portable LCD input text requests pass to host executors. */
export interface AgentTextRequest<TMetadata = Record<string, unknown>> {
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

/** Inline input for the `agent.decide` builtin actor. */
export interface AgentDecisionInput<TMetadata = Record<string, unknown>> {
  model: string;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  allowedEvents?: AllowedEvents;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: TMetadata;
}

type BuiltinAgentActors = {
  [GENERATE_TEXT_ACTOR]: AsyncActorLogic<unknown, AgentTextRequest>;
  [STREAM_TEXT_ACTOR]: AsyncActorLogic<unknown, AgentTextRequest>;
  [USER_INPUT_ACTOR]: AsyncActorLogic<unknown, AgentUserInput>;
  [DECIDE_ACTOR]: AsyncActorLogic<ChosenEvent, AgentDecisionInput>;
};

type AgentExecutionOptions = Pick<AgentRequestOptions, 'schemas' | 'actors'>;
const agentExecutionOptions = new WeakMap<object, AgentExecutionOptions>();

const agentTextInputSchema: StandardSchemaV1<AgentTextRequest> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      const ok =
        !!value
        && typeof value === 'object'
        && typeof (value as AgentTextRequest).model === 'string';

      return ok
        ? { value: value as AgentTextRequest }
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
  mode: AgentRequestMode,
  outputSchema: StandardSchemaV1
): AgentRequestLogic<StandardSchemaV1<AgentTextRequest>, StandardSchemaV1> {
  const logic = createAsyncLogic<unknown, AgentTextRequest>({
    run: async () => {
      throw new Error(
        `'${src}' has no host execution. Provide an implementation with ` +
          `machine.provide({ actorSources: { '${src}': ... } }) or execute the ` +
        `returned agent request with executeAgentRequest(...).`
      );
    },
  });

  return Object.assign(logic, {
    kind: 'statelyai.textLogic' as const,
    mode,
    schemas: {
      input: agentTextInputSchema,
      output: outputSchema,
    },
    request(input: AgentTextRequest) {
      return validateSchemaSync(agentTextInputSchema, input);
    },
    async execute(input: AgentTextRequest, executors: AgentRequestExecutors) {
      const output = await executeAgentTextRequest(
        mode,
        src,
        validateSchemaSync(agentTextInputSchema, input),
        executors
      );

      return validateSchemaSync(outputSchema, output);
    },
    withExecutor(
      execute: TextLogicExecutor<
        StandardSchemaV1<AgentTextRequest>,
        StandardSchemaV1<unknown>,
        Record<string, unknown>
      >
    ) {
      return Object.assign(createTextLogic({
        mode,
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
        agentEvents: ({ input }) => input.eventTypes,
        temperature: ({ input }) => input.temperature,
        maxTokens: ({ input }) => input.maxTokens,
        topP: ({ input }) => input.topP,
        topK: ({ input }) => input.topK,
        seed: ({ input }) => input.seed,
        stopSequences: ({ input }) => input.stopSequences,
        metadata: ({ input }) => input.metadata,
      }, execute));
    },
  }) as AgentRequestLogic<
    StandardSchemaV1<AgentTextRequest>,
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

const userInputActor = createAsyncLogic<unknown, AgentUserInput>({
  run: async () => {
    throw new Error(
      `'${USER_INPUT_ACTOR}' has no host execution. Provide an implementation ` +
        `with machine.provide({ actorSources: { '${USER_INPUT_ACTOR}': ... } }).`
    );
  },
});

const agentDecisionInputSchema: StandardSchemaV1<AgentDecisionInput> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      const ok =
        !!value
        && typeof value === 'object'
        && typeof (value as AgentDecisionInput).model === 'string';

      return ok
        ? { value: value as AgentDecisionInput }
        : { issues: [{ message: 'Expected agent decision input with a model' }] };
    },
  },
};

function decideRequestFromInput(input: AgentDecisionInput): AgentDecisionRequest {
  const allowedEventTypes = resolveAllowedEventTypes(input.allowedEvents, input) ?? [];

  return {
    kind: 'decision',
    id: '',
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    messages: input.messages,
    events: allowedEventTypes.map((type) => ({
      type,
      toolName: sanitizeEventToolName(type),
    })),
    attempts: [],
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    topP: input.topP,
    topK: input.topK,
    seed: input.seed,
    stopSequences: input.stopSequences,
    metadata: input.metadata,
  };
}

// Placeholder DecisionLogic for the `agent.decide` builtin. Bespoke (not
// createDecisionLogic) because `maxRetries` is per-invoke inline input here,
// not a static config value.
function decideActorWithExecutor(
  execute?: AgentDecisionExecutor
): DecisionLogic<StandardSchemaV1<AgentDecisionInput>> {
  const logic = createAsyncLogic<ChosenEvent, AgentDecisionInput>({
    run: async ({ input, signal }) => {
      if (!execute) {
        throw new Error(
          `'${DECIDE_ACTOR}' has no host execution. Provide an implementation with ` +
            `machine.provide({ actorSources: { '${DECIDE_ACTOR}': ... } }) or resolve ` +
            `the returned agent request with resolveDecision(...).`
        );
      }

      return resolveDecision(decideRequestFromInput(input), execute, {
        maxRetries: input.maxRetries ?? 2,
        signal,
      });
    },
  });

  return Object.assign(logic, {
    kind: 'statelyai.decisionLogic' as const,
    maxRetries: 2,
    request: decideRequestFromInput,
    // Internal: see the analogous field in createDecisionLogic's return.
    allowedEventTypes: (input: AgentDecisionInput) =>
      resolveAllowedEventTypes(input.allowedEvents, input),
    withExecutor: (nextExecute: AgentDecisionExecutor) =>
      decideActorWithExecutor(nextExecute),
  }) as DecisionLogic<StandardSchemaV1<AgentDecisionInput>>;
}

function createDecideActor(): DecisionLogic<StandardSchemaV1<AgentDecisionInput>> {
  return decideActorWithExecutor();
}

function missingActor(src: string): AsyncActorLogic<unknown, unknown> {
  return createAsyncLogic<unknown, unknown>({
    run: async () => {
      throw new Error(
        `'${src}' has no host execution. Provide an implementation with ` +
          `machine.provide({ actorSources: { '${src}': ... } }).`
      );
    },
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
      jsonSchema: {
        input: () => resolvedSchema,
      },
    },
  };
}

// Only used by setupAgent.fromConfig(...) for static JSON/YAML workflow
// configs. JS callers should pass a real Standard Schema validator such as Zod
// to setupAgent(...); this intentionally covers the small JSON Schema subset we
// need for config boundary validation and provider structured-output metadata.
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

const workflowConfigWholeExpressionPattern = /^\{\{\s*([\s\S]*?)\s*\}\}$/;
const workflowConfigTemplateExpressionPattern = /\{\{\s*([\s\S]*?)\s*\}\}/g;

type ExpressionScope = {
  context?: unknown;
  event?: unknown;
  input?: unknown;
  output?: unknown;
};

// Static workflow configs cannot carry functions, so this tiny expression
// layer lowers JSON/YAML values into normal JS values before machine creation.
function evaluateWorkflowConfigPath(expression: string, scope: ExpressionScope): unknown {
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

function evaluateWorkflowConfigValue(value: unknown, scope: ExpressionScope): unknown {
  if (typeof value === 'string') {
    const wholeMatch = value.match(workflowConfigWholeExpressionPattern);
    if (wholeMatch?.[1]) {
      return evaluateWorkflowConfigPath(wholeMatch[1], scope);
    }

    return value.replace(workflowConfigTemplateExpressionPattern, (_match, expression: string) => {
      const resolved = evaluateWorkflowConfigPath(expression, scope);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => evaluateWorkflowConfigValue(item, scope));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        evaluateWorkflowConfigValue(item, scope),
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
  toolMessage,
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
): (args: { context: TContext; event: TEvent }) => {
  context: { messages: AgentMessage[] };
} {
  return (args: { context: TContext; event: TEvent }) => ({
    context: {
      messages: addMessages(resolve)(args),
    },
  });
}

const KNOWN_PART_TYPES = new Set([
  'text',
  'image',
  'file',
  'tool-call',
  'tool-result',
]);

function isKnownPart(part: unknown): part is { type: string } {
  return (
    !!part
    && typeof part === 'object'
    && KNOWN_PART_TYPES.has((part as { type?: unknown }).type as string)
  );
}

function validatePartsArray(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return 'Expected content to be a string or an array of parts';
  }
  for (const part of content) {
    if (!isKnownPart(part)) {
      const type =
        part && typeof part === 'object' ? (part as { type?: unknown }).type : undefined;
      return `Unknown message part type: ${JSON.stringify(type)}`;
    }
  }
  return undefined;
}

/** Standard schema for an `AgentMessage[]` context field. */
export const messagesSchema: StandardSchemaV1<AgentMessage[]> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      if (!Array.isArray(value)) {
        return { issues: [{ message: 'Expected an array of agent messages' }] };
      }

      for (const message of value) {
        if (!message || typeof message !== 'object') {
          return { issues: [{ message: 'Expected an array of agent messages' }] };
        }

        const role = (message as { role?: unknown }).role;
        const content = (message as { content?: unknown }).content;

        if (
          role !== 'system'
          && role !== 'user'
          && role !== 'assistant'
          && role !== 'tool'
        ) {
          return {
            issues: [{ message: `Unknown message role: ${JSON.stringify(role)}` }],
          };
        }

        if (role === 'system') {
          if (typeof content !== 'string') {
            return {
              issues: [{ message: 'system message content must be a string' }],
            };
          }
          continue;
        }

        if (role === 'tool') {
          const error =
            validatePartsArray(content)
            ?? ((content as Array<{ type?: unknown }>).some(
              (part) => part.type !== 'tool-result'
            )
              ? 'tool message content must contain only tool-result parts'
              : undefined);
          if (error) {
            return { issues: [{ message: error }] };
          }
          continue;
        }

        // user | assistant: string or a parts array
        if (typeof content === 'string') {
          continue;
        }
        const error = validatePartsArray(content);
        if (error) {
          return { issues: [{ message: error }] };
        }
      }

      return { value: value as AgentMessage[] };
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
  mode?: AgentRequestMode;
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
  /** Machine event types to expose to the model as event tools. */
  agentEvents?: ResolveTextLogicValue<
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
  request: AgentTextRequest<TMetadata>;
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
> extends AsyncActorLogic<
    InferOutput<TOutputSchema>,
    InferOutput<TInputSchema>
  > {
  readonly kind: 'statelyai.textLogic';
  readonly mode: AgentRequestMode;
  readonly schemas: {
    readonly input: TInputSchema;
    readonly output: TOutputSchema;
  };
  request(input: InferOutput<TInputSchema>): AgentTextRequest<TMetadata>;
  execute(
    input: InferOutput<TInputSchema>,
    executors: AgentRequestExecutors
  ): Promise<InferOutput<TOutputSchema>>;
  withExecutor(
    execute: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>
  ): TextLogic<TInputSchema, TOutputSchema, TMetadata>;
}

export interface AgentRequestLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = Record<string, unknown>,
> extends TextLogic<TInputSchema, TOutputSchema, TMetadata> {
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
  const request = (input: TInput): AgentTextRequest<TMetadata> => {
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
      eventTypes: resolveTextLogicValue(config.agentEvents, args),
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
  const logic = createAsyncLogic<TOutput, TInput>({
    run: async ({ input, signal, system, self }, enq) => {
      const resolvedRequest = request(input);

      if (!execute) {
        throw new Error(
          'Text logic has no host execution. Pass an executor as the second ' +
            'argument to createTextLogic(...), provide a runtime adapter, or ' +
            'extract it with getAgentRequests(..., { actors }).'
        );
      }

      const output = await execute({
        input,
        request: resolvedRequest,
        signal,
        system,
        self,
        emit: enq.emit as (emitted: EventObject) => void,
      });

      return validateSchemaSync<TOutput>(
        config.schemas.output as StandardSchemaV1<TOutput>,
        output
      );
    },
  });

  return Object.assign(logic, {
    kind: 'statelyai.textLogic' as const,
    mode: config.mode ?? 'generate',
    schemas: config.schemas,
    request,
    async execute(input: TInput, executors: AgentRequestExecutors) {
      const output = await executeAgentTextRequest(
        config.mode ?? 'generate',
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

function isAgentRequestLogic(value: unknown): value is AgentRequestLogic {
  return isTextLogic(value);
}

// ─── Decision logic ───

export interface DecisionLogicConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TEvent extends string = string,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  schemas?: { input: TInputSchema };
  model: ResolveTextLogicValue<string, InferOutput<TInputSchema>>;
  system?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  prompt?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  messages?: ResolveTextLogicValue<
    AgentMessage[] | undefined,
    InferOutput<TInputSchema>
  >;
  allowedEvents?: AllowedEvents<TEvent>;
  maxRetries?: number; // default 2
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

export interface DecisionLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends AsyncActorLogic<ChosenEvent, InferOutput<TInputSchema>> {
  readonly kind: 'statelyai.decisionLogic';
  readonly maxRetries: number;
  request(input: InferOutput<TInputSchema>): AgentDecisionRequest;
  withExecutor(execute: AgentDecisionExecutor): DecisionLogic<TInputSchema, TMetadata>;
}

function resolveAllowedEventTypes(
  allowedEvents: AllowedEvents | undefined,
  input: unknown
): readonly string[] | undefined {
  if (allowedEvents === undefined) {
    return undefined;
  }
  return typeof allowedEvents === 'function'
    ? allowedEvents({ input })
    : allowedEvents;
}

export function createDecisionLogic<
  TInputSchema extends StandardSchemaV1,
  TEvent extends string = string,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  config: DecisionLogicConfig<TInputSchema, TEvent, TMetadata>,
  execute?: AgentDecisionExecutor
): DecisionLogic<TInputSchema, TMetadata> {
  type TInput = InferOutput<TInputSchema>;
  const maxRetries = config.maxRetries ?? 2;

  const request = (input: TInput): AgentDecisionRequest => {
    const parsedInput = config.schemas
      ? validateSchemaSync<TInput>(
        config.schemas.input as StandardSchemaV1<TInput>,
        input
      )
      : input;
    const args = { input: parsedInput };

    const allowedEventTypes = resolveAllowedEventTypes(
      config.allowedEvents as AllowedEvents | undefined,
      parsedInput
    );

    return {
      kind: 'decision',
      id: '',
      model: resolveTextLogicValue(config.model, args)!,
      system: resolveTextLogicValue(config.system, args),
      prompt: resolveTextLogicValue(config.prompt, args),
      messages: resolveTextLogicValue(config.messages, args),
      events: (allowedEventTypes ?? []).map((type) => ({
        type,
        toolName: sanitizeEventToolName(type),
      })),
      attempts: [],
      temperature: resolveTextLogicValue(config.temperature, args),
      maxTokens: resolveTextLogicValue(config.maxTokens, args),
      topP: resolveTextLogicValue(config.topP, args),
      topK: resolveTextLogicValue(config.topK, args),
      seed: resolveTextLogicValue(config.seed, args),
      stopSequences: resolveTextLogicValue(config.stopSequences, args),
      metadata: resolveTextLogicValue(config.metadata, args),
    };
  };

  const logic = createAsyncLogic<ChosenEvent, TInput>({
    run: async ({ input, signal }) => {
      if (!execute) {
        throw new Error(
          'Decision logic has no host execution. Pass an executor as the second ' +
            'argument to createDecisionLogic(...), provide a runtime adapter, or ' +
            'extract it with getAgentRequests(..., { actors }) and resolveDecision(...).'
        );
      }

      // Bare createActor path: no snapshot to intersect with, so only
      // modes 1-2 (type + payload validation) apply here — no canTake.
      return resolveDecision(request(input), execute, { maxRetries, signal });
    },
  });

  return Object.assign(logic, {
    kind: 'statelyai.decisionLogic' as const,
    maxRetries,
    request,
    // Internal: the raw declared `allowedEvents`, resolved but NOT yet
    // defaulted to `[]` — `undefined` here means "all legal events" and is
    // used by getAgentRequests to intersect with the snapshot correctly.
    // Not part of the public DecisionLogic type.
    allowedEventTypes: (input: TInput) =>
      resolveAllowedEventTypes(config.allowedEvents as AllowedEvents | undefined, input),
    withExecutor(nextExecute: AgentDecisionExecutor) {
      return createDecisionLogic(config, nextExecute);
    },
  }) as DecisionLogic<TInputSchema, TMetadata>;
}

function isDecisionLogic(value: unknown): value is DecisionLogic {
  return (
    !!value
    && typeof value === 'object'
    && (value as DecisionLogic).kind === 'statelyai.decisionLogic'
    && typeof (value as DecisionLogic).request === 'function'
  );
}

export type AgentRequestSource = string & {};

export const EVENT_TOOL_PREFIX = 'send_event_' as const;

export type AgentEventToolNameResolver = (args: {
  eventType: string;
  defaultToolName: string;
}) => string;

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeEventToolName(eventType: string): `${typeof EVENT_TOOL_PREFIX}${string}` {
  const sanitizedType = eventType.replace(/[^a-zA-Z0-9_-]/g, '_') || 'event';
  const base = `${EVENT_TOOL_PREFIX}${sanitizedType}`;

  if (base.length <= 64) {
    return base as `${typeof EVENT_TOOL_PREFIX}${string}`;
  }

  const hash = hashString(eventType);
  const prefixLength = 64 - hash.length - 1;
  return `${base.slice(0, prefixLength)}_${hash}` as `${typeof EVENT_TOOL_PREFIX}${string}`;
}

function disambiguateEventToolName(
  toolName: string,
  eventType: string,
  usedToolNames: Set<string>
): string {
  if (!usedToolNames.has(toolName)) {
    usedToolNames.add(toolName);
    return toolName;
  }

  const hash = hashString(eventType);
  const suffix = `_${hash}`;
  const uniqueToolName = `${toolName.slice(0, 64 - suffix.length)}${suffix}`;
  usedToolNames.add(uniqueToolName);
  return uniqueToolName;
}

export interface AgentRequest<TInput extends AgentTextRequest = AgentTextRequest> {
  kind: 'text';
  id: string;
  src: AgentRequestSource;
  mode?: AgentRequestMode;
  input: TInput;
  tools: AgentTools;
  events: AgentEventDescriptor[];
}

export interface AgentEventDescriptor {
  type: string;
  toolName: string;
  inputSchema?: StandardSchemaV1;
}

/**
 * A decision request: resolves to exactly one currently-legal event. See
 * `resolveDecision`.
 */
export interface AgentDecisionRequest {
  kind: 'decision';
  /** Durable invoke id. */
  id: string;
  model: string;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  /** Candidate events: declared `allowedEvents` ∩ snapshot-legal events. */
  events: AgentEventDescriptor[];
  /**
   * Prior failed attempts for THIS decision. Empty on the first attempt.
   * Adapters render these into the provider request so retries converge.
   * Core never rewrites prompts/messages — attempts are data on the request.
   */
  attempts: DecisionAttempt[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

/** `AgentStep.requests` element: a text request or a decision request. */
export type AgentStepRequest = AgentRequest | AgentDecisionRequest;

export interface DecisionAttempt {
  event?: ChosenEvent;
  failure: 'unknown-event' | 'invalid-payload' | 'rejected-by-guard';
  reason: string;
}

export class DecisionExhaustedError extends Error {
  attempts: DecisionAttempt[];

  constructor(attempts: DecisionAttempt[]) {
    super(
      `Decision exhausted after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}: ` +
        attempts.map((attempt) => attempt.reason).join('; ')
    );
    this.name = 'DecisionExhaustedError';
    this.attempts = attempts;
  }
}

/** Third executor slot, symmetric with generateText/streamText. */
export type AgentDecisionExecutor = (
  request: AgentDecisionRequest
) => PromiseLike<{ event: ChosenEvent; reason?: string }>;

export interface ResolveDecisionOptions {
  maxRetries?: number; // default 2 (⇒ up to 3 attempts)
  signal?: AbortSignal;
  /** Mode-3 guard check. Omit ⇒ mode-3 skipped (modes 1–2 only). */
  canTake?: (event: ChosenEvent) => boolean;
}

/**
 * Validation + retry core for decisions. No provider mechanics — the
 * `executor` is responsible for making the model choose an event; this
 * function only validates the choice and retries on failure.
 */
export async function resolveDecision(
  request: AgentDecisionRequest,
  executor: AgentDecisionExecutor,
  options: ResolveDecisionOptions = {}
): Promise<ChosenEvent> {
  const maxRetries = options.maxRetries ?? 2;
  const attempts: DecisionAttempt[] = [];
  const eventsByType = new Map(request.events.map((event) => [event.type, event]));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    options.signal?.throwIfAborted();
    const { event } = await executor({ ...request, attempts: [...attempts] });

    const descriptor = eventsByType.get(event.type);
    if (!descriptor) {
      attempts.push({
        event,
        failure: 'unknown-event',
        reason: `'${event.type}' is not among the currently allowed events: ${
          request.events.map((candidate) => candidate.type).join(', ') || '(none)'
        }.`,
      });
      continue;
    }

    let validatedEvent = event;
    if (descriptor.inputSchema) {
      const { type, ...payload } = event;
      try {
        const validatedPayload = validateSchemaSync(descriptor.inputSchema, payload);
        validatedEvent = { ...(validatedPayload as Record<string, unknown>), type };
      } catch (error) {
        attempts.push({
          event,
          failure: 'invalid-payload',
          reason: `'${event.type}' payload failed validation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
    }

    if (options.canTake?.(validatedEvent) === false) {
      attempts.push({
        event: validatedEvent,
        failure: 'rejected-by-guard',
        reason: `'${validatedEvent.type}' is not currently takeable (guard rejected it).`,
      });
      continue;
    }

    return validatedEvent;
  }

  throw new DecisionExhaustedError(attempts);
}

/**
 * Transition-function factory for an `agent.decide` invoke's `onDone`.
 * Delivers the chosen event via `enq.sendTo(self, …)` — external and
 * observable (event-sourcing, §4.3) — rather than `enq.raise` (internal).
 *
 * v6 alpha transition functions are re-evaluated multiple times per
 * transition (spike S3: 8x) — purity is load-bearing here. This function
 * only calls `enq`, never side-effects directly, so re-evaluation is safe.
 */
export function sendDecision<
  TEvent extends EventObject = EventObject,
  TEmitted extends EventObject = EventObject,
>(): (
  args: { output: ChosenEvent; self: AnyActorRef },
  enq: EnqueueObject<TEvent, TEmitted>
) => void {
  return ({ output, self }, enq) => {
    enq.sendTo(self, output as TEvent);
  };
}

export interface AgentSchemas {
  events?: Record<string, StandardSchemaV1>;
}

export interface AgentRequestOptions {
  snapshot?: AnyMachineSnapshot;
  events?: Record<string, StandardSchemaV1>;
  schemas?: AgentSchemas;
  actors?: Record<string, unknown>;
  /** Customize machine-event tool names. Defaults to send_event_<TYPE>. */
  eventToolName?: AgentEventToolNameResolver;
}

export function getAvailableEvents(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, 'events' | 'schemas' | 'eventToolName'> & {
    eventTypes?: readonly string[];
  } = {}
): AgentEventDescriptor[] {
  const eventTypes =
    options.eventTypes === undefined
      ? undefined
      : new Set(options.eventTypes);
  const seen = new Set<string>();
  const usedToolNames = new Set<string>();

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
    const defaultToolName = sanitizeEventToolName(eventType);
    const toolName = options.eventToolName
      ? options.eventToolName({ eventType, defaultToolName })
      : disambiguateEventToolName(defaultToolName, eventType, usedToolNames);

    return [{
      type: eventType,
      toolName,
      ...((options.events ?? options.schemas?.events)?.[eventType]
        ? { inputSchema: (options.events ?? options.schemas?.events)![eventType] }
        : {}),
    }];
  });
}

export function getEventTools(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, 'events' | 'schemas' | 'eventToolName'> & {
    eventTypes?: readonly string[];
  } = {}
): AgentTools {
  return Object.fromEntries(
    getAvailableEvents(snapshot, options).map((event) => [
      event.toolName,
      {
        description: `Send the '${event.type}' event. Available from the current state.`,
        ...(event.inputSchema ? { inputSchema: event.inputSchema } : {}),
        execute: async (input: unknown = {}) => ({
          ...(input && typeof input === 'object' ? input : {}),
          type: event.type,
        }),
      },
    ])
  );
}

export function getAgentRequests(
  actions: readonly { type?: string; params?: unknown; id?: unknown; src?: unknown; input?: unknown; logic?: unknown }[],
  options: AgentRequestOptions = {}
): AgentStepRequest[] {
  return actions.flatMap((action): AgentStepRequest[] => {
    if (action.type !== 'xstate.spawnChild' && action.type !== '@xstate.start') {
      return [];
    }

    const params = action.type === '@xstate.start'
      ? action
      : action.params as
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

    const registeredLogic = isTextLogic(action.logic) || isDecisionLogic(action.logic)
      ? action.logic
      : options.actors?.[params.src];

    if (isDecisionLogic(registeredLogic)) {
      const decisionRequest = registeredLogic.request(params.input as never);
      // `undefined` (allowedEvents omitted) means "all legal events" — do
      // not default it to `[]` here or getAvailableEvents will filter
      // everything out.
      const allowedEventTypes = (
        registeredLogic as unknown as {
          allowedEventTypes?: (input: unknown) => readonly string[] | undefined;
        }
      ).allowedEventTypes?.(params.input);
      const events = options.snapshot
        ? getAvailableEvents(options.snapshot, {
          events: options.events,
          schemas: options.schemas,
          eventTypes: allowedEventTypes,
          eventToolName: options.eventToolName,
        })
        : [];

      return [{
        ...decisionRequest,
        id: params.id,
        events,
      }];
    }

    const textLogic = isTextLogic(registeredLogic) ? registeredLogic : undefined;
    const input = textLogic
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
        eventToolName: options.eventToolName,
      })
      : [];
    const eventTools = Object.fromEntries(
      events.map((event) => [
        event.toolName,
        {
          description: `Send the '${event.type}' event. Available from the current state.`,
          ...(event.inputSchema ? { inputSchema: event.inputSchema } : {}),
          execute: async (toolInput: unknown = {}) => ({
            ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
            type: event.type,
          }),
        },
      ])
    );

    return [{
      kind: 'text',
      id: params.id,
      src: params.src,
      ...(isAgentRequestLogic(textLogic) ? { mode: textLogic.mode } : {}),
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
  request: Pick<AgentRequest, 'id'> | string,
  output: unknown
): { type: `xstate.done.actor.${string}`; output: unknown } {
  const id = typeof request === 'string' ? request : request.id;
  return { type: `xstate.done.actor.${id}`, output };
}

export function transitionResult<TLogic extends AnyActorLogic>(
  logic: TLogic,
  snapshot: SnapshotFrom<TLogic>,
  request: Pick<AgentRequest, 'id'> | string,
  output: unknown
): [SnapshotFrom<TLogic>, ExecutableActionObjectFromLogic<TLogic>[]] {
  const event = doneEvent(request, output);
  const result = transition(logic, snapshot, event as never);
  applyFinalStateOutput(logic, result[0], event);
  return result;
}

export type AgentRequestExecutorResult =
  | { output: unknown }
  | { object: unknown }
  | { text: string }
  | { toolResults: Array<{ output?: unknown }> }
  | unknown;

export type AgentRequestExecutor<TResult = AgentRequestExecutorResult> = (
  request: AgentTextRequest & { tools: AgentTools }
) => PromiseLike<TResult> | TResult;

export interface AgentRequestExecutors<
  TGenerateResult = AgentRequestExecutorResult,
  TStreamResult = AgentRequestExecutorResult,
> {
  generateText: AgentRequestExecutor<TGenerateResult>;
  streamText?: AgentRequestExecutor<TStreamResult>;
  decide?: AgentDecisionExecutor;
}

export interface AgentStep<TSnapshot extends AnyMachineSnapshot = AnyMachineSnapshot> {
  snapshot: TSnapshot;
  actions: readonly { type?: string; params?: unknown }[];
  requests: AgentStepRequest[];
  done: boolean;
}

export type AgentOutputMode = 'structured' | 'text';

export function getAgentOutputMode(schema?: StandardSchemaV1): AgentOutputMode {
  const type = getStandardSchemaJsonType(schema);
  return type === 'object' ? 'structured' : 'text';
}

export function isStructuredOutputSchema(schema?: StandardSchemaV1): boolean {
  return getAgentOutputMode(schema) === 'structured';
}

function getStandardSchemaJsonType(schema?: StandardSchemaV1) {
  const jsonSchema = (
    schema?.['~standard'] as {
      jsonSchema?: { input?: () => { type?: unknown } | Promise<{ type?: unknown }> };
    } | undefined
  )?.jsonSchema?.input?.();

  return jsonSchema && !(jsonSchema instanceof Promise)
    ? jsonSchema.type
    : undefined;
}

export interface RunAgentOptions extends AgentRequestExecutors, Partial<AgentExecutionOptions> {
  input?: unknown;
  maxRequests?: number;
}

export async function runAgent<TMachine extends AnyActorLogic>(
  machine: TMachine,
  options: RunAgentOptions
): Promise<OutputFrom<TMachine>> {
  const { input, maxRequests = 100, ...executionOptions } = options;
  let step = initialAgentStep(machine, input, executionOptions);
  let requestCount = 0;

  while (!step.done) {
    if (step.requests.length === 0) {
      throw new Error('Agent run paused with no pending requests.');
    }

    const requests = step.requests;
    requestCount += requests.length;
    if (requestCount > maxRequests) {
      throw new Error(`Agent run exceeded maxRequests (${maxRequests}).`);
    }

    const results = await Promise.all(
      requests.map(async (request) => {
        if (request.kind === 'decision') {
          throw new Error(
            "runAgent(...) does not yet resolve 'decision' requests. Use " +
              'resolveDecision(request, executors.decide, ...) directly, or ' +
              'the step helpers (initialAgentStep/transitionAgentStep).'
          );
        }
        return {
          request,
          output: await executeAgentRequest(request, options),
        };
      })
    );

    for (const { request, output } of results) {
      step = resolveAgentStep(machine, step, request, output, executionOptions);
      if (step.done) {
        break;
      }
    }
  }

  return (step.snapshot as AnyMachineSnapshot).output as OutputFrom<TMachine>;
}

async function normalizeRequestExecutionResult(result: unknown): Promise<unknown> {
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
  mode: AgentRequestMode,
  id: string,
  input: AgentTextRequest<any>,
  executors: AgentRequestExecutors,
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
    mode === 'stream'
      ? executors.streamText
      : executors.generateText;

  if (!executor) {
    throw new Error(
      `No executor provided for ${mode === 'stream' ? 'stream' : 'generate'} request '${id}'.`
    );
  }

  return normalizeRequestExecutionResult(await executor(request));
}

function getRegisteredAgentExecutionOptions(
  machine: AnyActorLogic,
  options?: Partial<AgentExecutionOptions>
): AgentExecutionOptions {
  return {
    ...(agentExecutionOptions.get(machine as object) ?? {}),
    ...options,
  };
}

export function initialAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  input?: unknown,
  options?: Partial<AgentExecutionOptions>
): AgentStep<SnapshotFrom<TMachine>> {
  const [snapshot, actions] = initialTransition(machine, input as never);
  return createAgentStep(machine, snapshot, actions, getRegisteredAgentExecutionOptions(machine, options));
}

export function transitionAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  snapshotOrStep: SnapshotFrom<TMachine> | AgentStep<SnapshotFrom<TMachine>>,
  event: EventFromLogic<TMachine>,
  options?: Partial<AgentExecutionOptions>
): AgentStep<SnapshotFrom<TMachine>> {
  const snapshot = isAgentStep(snapshotOrStep)
    ? snapshotOrStep.snapshot
    : snapshotOrStep;
  const [nextSnapshot, actions] = transition(machine, snapshot, event as never);
  return createAgentStep(machine, nextSnapshot, actions, getRegisteredAgentExecutionOptions(machine, options));
}

export function resolveAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  step: AgentStep<SnapshotFrom<TMachine>>,
  request: Pick<AgentRequest, 'id'> | string,
  output: unknown,
  options?: Partial<AgentExecutionOptions>
): AgentStep<SnapshotFrom<TMachine>> {
  const [snapshot, actions] = transitionResult(machine, step.snapshot, request, output);
  return createAgentStep(machine, snapshot, actions, getRegisteredAgentExecutionOptions(machine, options));
}

export function getMachineAgentRequests(
  machine: AnyActorLogic,
  actions: readonly { type?: string; params?: unknown }[],
  snapshot?: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, 'eventToolName'> & Partial<AgentExecutionOptions> = {}
): AgentStepRequest[] {
  const machineOptions = getRegisteredAgentExecutionOptions(machine, options);

  return getAgentRequests(actions, {
    ...machineOptions,
    ...options,
    snapshot,
  });
}

export async function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors
): Promise<unknown> {
  if ((request as AgentStepRequest).kind === 'decision') {
    throw new Error(
      "executeAgentRequest(...) is text-only. Resolve a 'decision' request with " +
        'resolveDecision(request, executors.decide, ...) instead.'
    );
  }

  const output = await executeAgentTextRequest(
    request.mode ?? 'generate',
    request.id,
    request.input,
    executors,
    request.tools
  );

  return request.input.outputSchema
    ? validateSchemaSync(request.input.outputSchema, output)
    : output;
}

function createAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  snapshot: SnapshotFrom<TMachine>,
  actions: readonly { type?: string; params?: unknown }[],
  options?: AgentExecutionOptions
): AgentStep<SnapshotFrom<TMachine>> {
  applyFinalStateOutput(machine, snapshot);

  return {
    snapshot,
    actions,
    requests: getAgentRequests(actions, {
      ...options,
      snapshot: snapshot as AnyMachineSnapshot,
    }),
    done: (snapshot as AnyMachineSnapshot).status === 'done',
  };
}

function resolveStateValueConfig(
  config: { states?: Record<string, any> },
  value: unknown
): any {
  if (typeof value === 'string') {
    return config.states?.[value];
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const childConfig = config.states?.[key];
    if (!childConfig) {
      continue;
    }

    if (childConfig.type === 'final') {
      return childConfig;
    }

    const nested = resolveStateValueConfig(childConfig, childValue);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function applyFinalStateOutput(
  logic: AnyActorLogic,
  snapshot: unknown,
  event?: EventObject
) {
  const machineSnapshot = snapshot as AnyMachineSnapshot & {
    output?: unknown;
    context?: unknown;
    value?: unknown;
  };

  if (
    machineSnapshot.status !== 'done'
    || machineSnapshot.output !== undefined
    || !('config' in logic)
  ) {
    return;
  }

  const config = (logic as { config?: { states?: Record<string, any> } }).config;
  if (!config) {
    return;
  }

  const stateConfig = resolveStateValueConfig(config, machineSnapshot.value);
  const output = stateConfig?.output;
  if (output === undefined) {
    return;
  }

  machineSnapshot.output =
    typeof output === 'function'
      ? output({ context: machineSnapshot.context, event })
      : output;
}

function isAgentStep<TSnapshot extends AnyMachineSnapshot>(
  value: unknown
): value is AgentStep<TSnapshot> {
  return (
    !!value
    && typeof value === 'object'
    && 'snapshot' in value
    && 'actions' in value
    && 'requests' in value
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
  [K in keyof TActors]: TActors[K] extends AsyncActorLogic<infer TOutput, infer TInput>
    ? AsyncActorLogic<TOutput, TInput>
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

type AgentRequestEvents<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
  TInputSchema extends StandardSchemaV1,
> =
  | readonly (keyof TEventSchemas & string)[]
  | ((args: {
      input: InferOutput<TInputSchema>;
      schemas: TSchemas;
    }) => readonly (keyof TEventSchemas & string)[]);

type AgentRequestConfig<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = Record<string, unknown>,
> = Omit<
  TextLogicConfig<TInputSchema, TOutputSchema, TMetadata>,
  'agentEvents'
> & {
  mode?: AgentRequestMode;
  agentEvents?: AgentRequestEvents<TEventSchemas, TSchemas, TInputSchema>;
};

type AgentRequestSchemaMap = Record<
  string,
  {
    input: StandardSchemaV1;
    output: StandardSchemaV1;
  }
>;

type AgentRequestInput<
  TRequestSchemas extends AgentRequestSchemaMap,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
> = {
  [K in keyof TRequestSchemas]: AgentRequestConfig<
    TEventSchemas,
    TSchemas,
    TRequestSchemas[K]['input'],
    TRequestSchemas[K]['output']
  > & {
    schemas: TRequestSchemas[K];
    eventTypes?: never;
  };
};

type RequestActors<TRequestSchemas extends AgentRequestSchemaMap> = {
  [K in keyof TRequestSchemas]: AgentRequestLogic<
    TRequestSchemas[K]['input'],
    TRequestSchemas[K]['output']
  >;
};

type AgentAllActors<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
> = TActors & RequestActors<TRequestSchemas>;

type AgentSetupXStateConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
> = SetupConfig<
  {
    context: TContextSchema;
    events: TEventSchemas;
    input: TInputSchema;
    output: TOutputSchema;
    meta: TMetaSchema;
  },
  Record<string, never>,
  NonNullable<AnySetupConfig['actions']>,
  SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>>>,
  NonNullable<AnySetupConfig['guards']>,
  NonNullable<AnySetupConfig['delays']>
>;

type SetupAgentBaseConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
  TRequestSchemas extends AgentRequestSchemaMap,
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
  requests?: AgentRequestInput<
    TRequestSchemas,
    TEventSchemas,
    AgentSchemaPack<
      TContextSchema,
      TEventSchemas,
      TInputSchema,
      TOutputSchema,
      TMetaSchema
    >
  >;
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
> = SetupReturnFromConfig<
  AgentSetupXStateConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
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
> = Omit<
  SetupAgentXStateResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
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
    TMetaSchema
  >['createMachine'];
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
  >;
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
>(
  config: SetupAgentBaseConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TRequestSchemas
  >
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema
> {
  return createSetupAgent(config);
}

/** Serializable JSON/YAML workflow config. JS authoring should use setupAgent(...). */
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
  requests?: Record<string, AgentWorkflowRequestConfig>;
  actors?: Record<string, AgentWorkflowActorConfig>;
  initial: string;
  states: Record<string, AgentWorkflowStateConfig>;
  meta?: Record<string, unknown>;
}

export interface AgentWorkflowRequestConfig {
  mode?: AgentRequestMode;
  description?: string;
  model: unknown;
  system?: unknown;
  prompt?: unknown;
  messages?: unknown;
  input: JsonSchemaObject;
  output: JsonSchemaObject;
  agentEvents?: unknown;
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

function createRequestsFromWorkflowConfig(
  config: AgentWorkflowConfig
): AgentRequestInput<
  Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>,
  Record<string, StandardSchemaV1>,
  AgentSchemaPack<any, Record<string, StandardSchemaV1>, any, any, any>
> {
  return Object.fromEntries(
    Object.entries(config.requests ?? {}).map(([key, request]) => [
      key,
      {
        mode: request.mode,
        description: request.description,
        schemas: {
          input: jsonSchemaToStandardSchema(request.input, `${key}.input`),
          output: jsonSchemaToStandardSchema(request.output, `${key}.output`),
        },
        model: ({ input }) =>
          String(evaluateWorkflowConfigValue(request.model, { input }) ?? ''),
        system: request.system === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.system, { input }) as string | undefined,
        prompt: request.prompt === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.prompt, { input }) as string | undefined,
        messages: request.messages === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.messages, { input }) as
                | AgentMessage[]
                | undefined,
        tools: request.tools,
        toolChoice: request.toolChoice as AgentToolChoice | undefined,
        agentEvents: request.agentEvents === undefined
          ? undefined
          : ({ input }) => {
              const events = evaluateWorkflowConfigValue(request.agentEvents, { input });
              return Array.isArray(events)
                ? events.filter((event): event is string => typeof event === 'string')
                : [];
            },
        temperature: request.temperature === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.temperature, { input }) as
                | number
                | undefined,
        maxTokens: request.maxTokens === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.maxTokens, { input }) as number | undefined,
        topP: request.topP === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.topP, { input }) as number | undefined,
        topK: request.topK === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.topK, { input }) as number | undefined,
        seed: request.seed === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.seed, { input }) as number | undefined,
        stopSequences: request.stopSequences === undefined
          ? undefined
          : ({ input }) =>
              evaluateWorkflowConfigValue(request.stopSequences, { input }) as
                | string[]
                | undefined,
        metadata: request.metadata === undefined
          ? undefined
          : ({ input }) => evaluateWorkflowConfigValue(request.metadata, { input }),
      },
    ])
  ) as AgentRequestInput<
    Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>,
    Record<string, StandardSchemaV1>,
    AgentSchemaPack<any, Record<string, StandardSchemaV1>, any, any, any>
  >;
}

function createActorPlaceholdersFromWorkflowConfig(config: AgentWorkflowConfig) {
  return Object.fromEntries(
    Object.keys(config.actors ?? {}).map((key) => [key, missingActor(key)])
  ) as Record<string, AsyncActorLogic<unknown, unknown>>;
}

function createAssignAction(assignConfig: Record<string, unknown>) {
  return ({ context, event }: { context: Record<string, unknown>; event: unknown }) => ({
    context: Object.fromEntries(
      Object.entries(assignConfig).map(([key, value]) => [
        key,
        evaluateWorkflowConfigValue(value, { context, event }),
      ])
    ),
  });
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
            evaluateWorkflowConfigValue(action.params, { context, event }),
        }
  );
}

function workflowTransitionMatches(
  transitionConfig: AgentWorkflowTransitionConfig,
  scope: { context: unknown; event: unknown }
) {
  if (transitionConfig.guard === undefined) {
    return true;
  }

  if (typeof transitionConfig.guard === 'string') {
    return Boolean(evaluateWorkflowConfigValue(transitionConfig.guard, scope));
  }

  return typeof transitionConfig.guard === 'function'
    ? transitionConfig.guard(scope as never)
    : false;
}

function lowerWorkflowTransitionResult(
  transitionConfig: AgentWorkflowTransitionConfig,
  scope: { context: unknown; event: unknown }
) {
  return {
    ...(transitionConfig.target !== undefined
      ? { target: transitionConfig.target }
      : {}),
    ...(transitionConfig.assign
      ? {
          context: Object.fromEntries(
            Object.entries(transitionConfig.assign).map(([key, value]) => [
              key,
              evaluateWorkflowConfigValue(value, scope),
            ])
          ),
        }
      : {}),
    ...(transitionConfig.description !== undefined
      ? { description: transitionConfig.description }
      : {}),
    ...(transitionConfig.reenter !== undefined
      ? { reenter: transitionConfig.reenter }
      : {}),
    ...(transitionConfig.meta !== undefined ? { meta: transitionConfig.meta } : {}),
  };
}

function lowerWorkflowTransition(
  transitionConfig: AgentWorkflowTransitionConfig
) {
  return ({ context, event }: { context: unknown; event: unknown }) => {
    const scope = { context, event };
    return workflowTransitionMatches(transitionConfig, scope)
      ? lowerWorkflowTransitionResult(transitionConfig, scope)
      : undefined;
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
    ? ({ context, event }: { context: unknown; event: unknown }) => {
        const scope = { context, event };
        const transition = transitionConfig.find((candidate) =>
          workflowTransitionMatches(candidate, scope)
        );
        return transition
          ? lowerWorkflowTransitionResult(transition, scope)
          : undefined;
      }
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
            evaluateWorkflowConfigValue(invokeConfig.input, { context, event }),
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
            evaluateWorkflowConfigValue(stateConfig.output, { context, event }),
        }
      : {}),
    ...(stateConfig.meta !== undefined ? { meta: stateConfig.meta } : {}),
  };
}

function setupAgentFromConfig(config: AgentWorkflowConfig): AnyStateMachine {
  const schemas = createSchemasFromWorkflowConfig(config);
  const requests = createRequestsFromWorkflowConfig(config);
  const requestActors = createRequestActors(schemas, requests);
  const actors = createActorPlaceholdersFromWorkflowConfig(config);
  const agent = setupAgent({
    schemas,
    actors: {
      ...actors,
      ...requestActors,
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
              evaluateWorkflowConfigValue(config.context, { input })
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
  export function fromConfig(config: AgentWorkflowConfig): AnyStateMachine {
    return setupAgentFromConfig(config);
  }
}

function createRequestActors<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
  TRequestSchemas extends AgentRequestSchemaMap,
>(schemas: TSchemas, requests: AgentRequestInput<TRequestSchemas, TEventSchemas, TSchemas>): RequestActors<TRequestSchemas> {
  return Object.fromEntries(
    Object.entries(requests).map(([key, request]) => {
      const logic = createTextLogic({
        ...request,
        mode: request.mode ?? 'generate',
        agentEvents: request.agentEvents
          ? ({ input }) => {
              return typeof request.agentEvents === 'function'
                ? request.agentEvents({ input, schemas })
                : request.agentEvents;
            }
          : undefined,
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
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TSchemas extends AgentSchemaPack<any, TEventSchemas, any, any, any>,
>(
  requests: AgentRequestInput<TRequestSchemas, TEventSchemas, TSchemas> | undefined
): AgentRequestInput<TRequestSchemas, TEventSchemas, TSchemas> {
  return requests ?? ({} as AgentRequestInput<TRequestSchemas, TEventSchemas, TSchemas>);
}

function createAgentActorSources<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
>(
  actors: TActors | undefined,
  requestActors: RequestActors<TRequestSchemas>
): SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>>> {
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
>(
  schemas: AgentSchemaPack<
    TContextSchema,
    TEventSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
  >,
  actorSources: SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas>>>,
  config: Pick<
    SetupAgentBaseConfig<
      TContextSchema,
      TEventSchemas,
      TActors,
      TInputSchema,
      TOutputSchema,
      TMetaSchema,
      TRequestSchemas
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
  TMetaSchema
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
>(
  config: SetupAgentBaseConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TInputSchema,
    TOutputSchema,
    TMetaSchema,
    TRequestSchemas
  >
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema
> {
  const schemas = normalizeAgentSchemas(config);
  const requests = normalizeAgentRequestInput<
    TRequestSchemas,
    TEventSchemas,
    typeof schemas
  >(config.requests);
  const requestActors = createRequestActors(
    schemas,
    requests
  );
  const actorSources = createAgentActorSources(config.actors, requestActors);
  const setupConfig = createAgentSetupConfig<
      TContextSchema,
      TEventSchemas,
      TActors,
      TRequestSchemas,
      TInputSchema,
      TOutputSchema,
      TMetaSchema
    >(schemas, actorSources, config);
  const base = setup(setupConfig);
  const createBaseMachine = base.createMachine.bind(base);
  const machineOptions = {
    schemas,
    actors: actorSources,
  };

  return Object.assign(base, {
    createMachine(machineConfig: Parameters<typeof base.createMachine>[0]) {
      const machine = createBaseMachine(
        withRootOutputFromSingleFinal(machineConfig) as never
      );
      agentExecutionOptions.set(machine as object, machineOptions);
      return machine;
    },
    schemas,
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
    TMetaSchema
  >;
}
