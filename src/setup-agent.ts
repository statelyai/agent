import {
  createActor,
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
  type InputFrom,
  type InspectionEvent,
  type MachineContext,
  type MetaObject,
  type NonReducibleUnknown,
  type OutputFrom,
  type SetupConfig,
  type SetupReturnFromConfig,
  type Snapshot,
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
): TextLogic<StandardSchemaV1<AgentTextRequest>, StandardSchemaV1> {
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
      const { output } = await executeAgentTextRequest(
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
        temperature: ({ input }) => input.temperature,
        maxTokens: ({ input }) => input.maxTokens,
        topP: ({ input }) => input.topP,
        topK: ({ input }) => input.topK,
        seed: ({ input }) => input.seed,
        stopSequences: ({ input }) => input.stopSequences,
        metadata: ({ input }) => input.metadata,
      }, execute));
    },
  }) as TextLogic<
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

// Actor logic objects that are unbound placeholders (no host execution) and
// carry no `kind` marker of their own — `agent.userInput` and workflow-config
// actor stubs. runAgent's bind-time walk (§3.2) checks membership here to
// fail fast on invokes that reach one of these unimplemented.
const unboundPlaceholderLogics = new WeakSet<object>();
/** Text/decision logics created WITH their own executor (withExecutor or the
 * factory's second arg) — these are runnable as-is, so runAgent's bind check
 * must not reject them as direct-object invoke srcs. */
const executorBoundLogics = new WeakSet<object>();

const userInputActor = createAsyncLogic<unknown, AgentUserInput>({
  run: async () => {
    throw new Error(
      `'${USER_INPUT_ACTOR}' has no host execution. Provide an implementation ` +
        `with machine.provide({ actorSources: { '${USER_INPUT_ACTOR}': ... } }).`
    );
  },
});
unboundPlaceholderLogics.add(userInputActor);

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
  const logic = createAsyncLogic<unknown, unknown>({
    run: async () => {
      throw new Error(
        `'${src}' has no host execution. Provide an implementation with ` +
          `machine.provide({ actorSources: { '${src}': ... } }).`
      );
    },
  });
  unboundPlaceholderLogics.add(logic);
  return logic;
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

  const textLogic = Object.assign(logic, {
    kind: 'statelyai.textLogic' as const,
    mode: config.mode ?? 'generate',
    schemas: config.schemas,
    request,
    async execute(input: TInput, executors: AgentRequestExecutors) {
      const { output } = await executeAgentTextRequest(
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

  if (execute) {
    executorBoundLogics.add(textLogic as object);
  }

  return textLogic;
}

function isTextLogic(value: unknown): value is TextLogic {
  return (
    !!value
    && typeof value === 'object'
    && (value as TextLogic).kind === 'statelyai.textLogic'
    && typeof (value as TextLogic).request === 'function'
  );
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

  const decisionLogic = Object.assign(logic, {
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

  if (execute) {
    executorBoundLogics.add(decisionLogic as object);
  }

  return decisionLogic;
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

export function getAcceptedEvents(
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
      // not default it to `[]` here or getAcceptedEvents will filter
      // everything out.
      const allowedEventTypes = (
        registeredLogic as unknown as {
          allowedEventTypes?: (input: unknown) => readonly string[] | undefined;
        }
      ).allowedEventTypes?.(params.input);
      const events = options.snapshot
        ? getAcceptedEvents(options.snapshot, {
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

    return [{
      kind: 'text',
      id: params.id,
      src: params.src,
      ...(textLogic ? { mode: textLogic.mode } : {}),
      input,
      tools: input.tools ?? {},
      events: [],
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
  | unknown;

/**
 * Optional second argument passed to executors by `runAgent`. The step path
 * (`executeAgentRequest`) never passes this — chunk streaming only exists on
 * the live path, where `onChunk` (§3.1) needs a way to reach the executor.
 */
export interface AgentRequestExecutorInfo {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export type AgentRequestExecutor<TResult = AgentRequestExecutorResult> = (
  request: AgentTextRequest & { tools: AgentTools },
  info?: AgentRequestExecutorInfo
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

// ─── runAgent (createActor wrapper) ───
//
// See docs/p0-design.md §3. Unlike the step helpers above (a pure
// transition-at-a-time path for durable hosts), `runAgent` owns a live
// `createActor` actor: it binds host executors directly onto the machine's
// agent actor sources, runs the actor to completion or idle, and reports a
// `done | idle | error` result. There is no continuation callback — idle
// always settles and the caller resumes by snapshot (§3.4).

export interface AgentUserInputExecutor {
  (input: AgentUserInput): PromiseLike<unknown>;
}

export interface RunAgentOptions<TMachine extends AnyStateMachine>
  extends AgentRequestExecutors {
  input?: InputFrom<TMachine>;

  // resume
  snapshot?: Snapshot<unknown>;
  event?: EventFromLogic<TMachine>;

  // implementations — sugar for machine.provide({ actorSources }) before the run
  actorSources?: Record<string, AnyActorLogic>;

  /**
   * Optional human-input handler for `agent.userInput` invokes (CLI prompt,
   * web form, Slack, …). Idle-first HITL stays the default: model human input
   * as event-waiting states and `runAgent` settles `idle`. Provide this only
   * when input should be gathered inline without settling. If the machine
   * uses `agent.userInput` and neither this nor a provided actor source
   * handles it, binding fails fast (message recommends the idle-state
   * pattern).
   */
  userInput?: AgentUserInputExecutor;

  // observation — all void; no callback controls the run
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (
    request: AgentStepRequest,
    result: { output: unknown; raw: unknown }
  ) => void;
  /**
   * Fires on every machine transition (snapshot + causing event). Pure
   * observation — progress UIs, logging, tracing. Cannot send events.
   */
  onTransition?: (
    snapshot: SnapshotFrom<TMachine>,
    event: EventFromLogic<TMachine>
  ) => void;

  // control
  maxModelCalls?: number; // default 100
  signal?: AbortSignal;
}

export type RunAgentResult<TMachine extends AnyStateMachine> =
  | { status: 'done'; output: OutputFrom<TMachine>; snapshot: SnapshotFrom<TMachine> }
  | { status: 'idle'; snapshot: SnapshotFrom<TMachine> }
  | {
      status: 'error';
      cause: 'aborted' | 'max-model-calls' | 'machine';
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

class MaxModelCallsExceededError extends Error {
  constructor() {
    super('runAgent exceeded maxModelCalls.');
    this.name = 'MaxModelCallsExceededError';
  }
}

/**
 * Recursively collects every invoke's `src` from raw machine config (spike
 * S6: `machine.config` preserves authored srcs; the built `machine.root`
 * normalizes object srcs to synthetic string ids and loses the distinction
 * this walk needs). Function-valued `src` resolvers are dynamic and are not
 * statically analyzable, so they are skipped (pass-through, like any other
 * non-agent actor).
 */
function collectConfiguredInvokeSrcs(
  stateConfig: { states?: Record<string, any>; invoke?: unknown } | undefined,
  stateName: string,
  out: Array<{ stateName: string; src: string | AnyActorLogic }>
): void {
  if (!stateConfig) {
    return;
  }

  const invokes = stateConfig.invoke === undefined
    ? []
    : Array.isArray(stateConfig.invoke)
      ? stateConfig.invoke
      : [stateConfig.invoke];

  for (const invokeConfig of invokes) {
    const src = (invokeConfig as { src?: unknown } | undefined)?.src;
    if (typeof src === 'string' || (src && typeof src === 'object')) {
      out.push({ stateName, src: src as string | AnyActorLogic });
    }
    // Function-valued `src` resolvers are dynamic; not walked (see above).
  }

  for (const [childName, childConfig] of Object.entries(stateConfig.states ?? {})) {
    collectConfiguredInvokeSrcs(childConfig, `${stateName}.${childName}`, out);
  }
}

function isUnboundPlaceholder(logic: unknown): boolean {
  return !!logic && typeof logic === 'object' && unboundPlaceholderLogics.has(logic as object);
}

/**
 * Fails fast (throws) at bind time — before any actor runs — when the
 * machine invokes an agent actor `runAgent` cannot execute. See §3.2 point 2.
 */
function assertBindable(
  machine: AnyStateMachine,
  effectiveSources: Record<string, AnyActorLogic>,
  options: { hasDecide: boolean; hasStreamText: boolean; hasUserInput: boolean }
): void {
  const invokes: Array<{ stateName: string; src: string | AnyActorLogic }> = [];
  collectConfiguredInvokeSrcs(machine.config as never, machine.config.id ?? '(root)', invokes);

  for (const { stateName, src } of invokes) {
    if (typeof src !== 'string') {
      // Direct-object src: string-keyed sources can be rebound by runAgent;
      // direct objects cannot. Only a problem if it's an agent logic that
      // still needs execution (no executor of its own).
      if (
        (isTextLogic(src) || isDecisionLogic(src))
        && !executorBoundLogics.has(src as object)
      ) {
        throw new Error(
          `runAgent: state '${stateName}' invokes a direct-object actor logic ` +
            `(kind: '${(src as TextLogic | DecisionLogic).kind}'). Direct-object invoke ` +
            `srcs cannot be rebound by runAgent — either call '.withExecutor(...)' on ` +
            `the logic before invoking it, or register it as a string-keyed actor ` +
            `source instead (machine.provide({ actorSources: { name: logic } })) and ` +
            `invoke it by name.`
        );
      }
      continue;
    }

    const logic = effectiveSources[src];

    if (logic === undefined) {
      throw new Error(
        `runAgent: state '${stateName}' invokes unregistered actor source '${src}'. ` +
          `Provide it via machine.provide({ actorSources: { '${src}': ... } }) or ` +
          `runAgent(machine, { actorSources: { '${src}': ... } }).`
      );
    }

    if (src === USER_INPUT_ACTOR) {
      if (!options.hasUserInput && isUnboundPlaceholder(logic)) {
        throw new Error(
          `runAgent: state '${stateName}' invokes '${USER_INPUT_ACTOR}' but no ` +
            `'userInput' option or actor source was provided. Either pass ` +
            `{ userInput: async (input) => ... } to runAgent, provide an actor ` +
            `source for '${USER_INPUT_ACTOR}', or model this as an idle state ` +
            `that waits for an externally-sent event instead.`
        );
      }
      continue;
    }

    if (isDecisionLogic(logic)) {
      if (!options.hasDecide) {
        throw new Error(
          `runAgent: state '${stateName}' invokes decision source '${src}' but no ` +
            `'decide' executor was provided to runAgent(...).`
        );
      }
      continue;
    }

    if (isTextLogic(logic)) {
      if (logic.mode === 'stream' && !options.hasStreamText) {
        throw new Error(
          `runAgent: state '${stateName}' invokes streaming text source '${src}' but ` +
            `no 'streamText' executor was provided to runAgent(...).`
        );
      }
      continue;
    }

    if (isUnboundPlaceholder(logic)) {
      throw new Error(
        `runAgent: state '${stateName}' invokes actor source '${src}', which has no ` +
          `host execution. Provide it via machine.provide({ actorSources: { '${src}': ... } }) ` +
          `or runAgent(machine, { actorSources: { '${src}': ... } }).`
      );
    }

    // Non-agent actor (real run fn) — passes through untouched.
  }
}

interface RunAgentBindContext {
  generateText: AgentRequestExecutor;
  streamText?: AgentRequestExecutor;
  decide?: AgentDecisionExecutor;
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (
    request: AgentStepRequest,
    result: { output: unknown; raw: unknown }
  ) => void;
  consumeModelCall: () => void;
  /** Assigned right after createActor (§2.6); read lazily by decision wraps. */
  actorHolder: { actorRef: AnyActorRef | undefined };
}

/** Reads the durable invoke id/src off the async actor's own ref (`self`). */
function selfIdAndSrc(self: unknown): { id: string; src: string } {
  const ref = self as { id?: unknown; src?: unknown } | undefined;
  return {
    id: typeof ref?.id === 'string' ? ref.id : '',
    src: typeof ref?.src === 'string' ? ref.src : '',
  };
}

function wrapTextLogicForRunAgent(
  logic: TextLogic,
  runCtx: RunAgentBindContext
): TextLogic {
  return logic.withExecutor(async ({ request, self, signal }) => {
    const { id, src } = selfIdAndSrc(self);
    const executor = logic.mode === 'stream' ? runCtx.streamText : runCtx.generateText;
    if (!executor) {
      throw new Error(
        `runAgent: no '${logic.mode === 'stream' ? 'streamText' : 'generateText'}' ` +
          'executor provided.'
      );
    }

    const requestWithTools: AgentTextRequest & { tools: AgentTools } = {
      ...request,
      tools: request.tools ?? {},
    };
    const agentRequest: AgentRequest = {
      kind: 'text',
      id,
      src,
      mode: logic.mode,
      input: request,
      tools: requestWithTools.tools,
      events: [],
    };

    runCtx.consumeModelCall();
    const raw = await executor(requestWithTools, {
      onChunk: runCtx.onChunk
        ? (chunk: string) => runCtx.onChunk!(chunk, { request: agentRequest })
        : undefined,
      signal,
    });
    const output = await normalizeGeneratorResult(raw);

    runCtx.onResult?.(agentRequest, { output, raw });

    return output;
  });
}

async function normalizeGeneratorResult(result: unknown): Promise<unknown> {
  const resolved = await result;
  if (!resolved || typeof resolved !== 'object') {
    return resolved;
  }
  if ('object' in resolved) {
    return await (resolved as { object: unknown }).object;
  }
  if ('text' in resolved) {
    return await (resolved as { text: string }).text;
  }
  if ('output' in resolved) {
    return await (resolved as { output: unknown }).output;
  }
  return resolved;
}

/**
 * Builds the decision actor logic runAgent installs in place of a
 * `DecisionLogic`/`agent.decide` source. `DecisionLogic.withExecutor(...)`
 * can only swap the innermost per-attempt executor — the `resolveDecision(...)`
 * call (and its `canTake`) is hardwired inside the original logic's `run`.
 * To supply `canTake` (mode-3, §2.6), runAgent instead builds a fresh async
 * logic here that calls `resolveDecision` itself, reusing `logic.request(...)`
 * to build the request the same way the original logic would have.
 */
function createRunAgentDecisionLogic(
  logic: DecisionLogic,
  runCtx: RunAgentBindContext
): DecisionLogic {
  const decisionLogic = createAsyncLogic<ChosenEvent, unknown>({
    run: async ({ input, signal, self }) => {
      if (!runCtx.decide) {
        throw new Error("runAgent: no 'decide' executor provided.");
      }
      const { id, src } = selfIdAndSrc(self);
      const request: AgentDecisionRequest = { ...logic.request(input as never), id };

      const countingDecide: AgentDecisionExecutor = async (attemptRequest) => {
        runCtx.consumeModelCall();
        const result = await runCtx.decide!(attemptRequest);
        runCtx.onResult?.(attemptRequest, { output: result.event, raw: result });
        return result;
      };

      return resolveDecision(request, countingDecide, {
        maxRetries: logic.maxRetries,
        signal,
        canTake: (event) => {
          const actorRef = runCtx.actorHolder.actorRef;
          return actorRef ? (actorRef.getSnapshot() as AnyMachineSnapshot).can(event) : true;
        },
      });
    },
  });

  return Object.assign(decisionLogic, {
    kind: 'statelyai.decisionLogic' as const,
    maxRetries: logic.maxRetries,
    request: logic.request,
    withExecutor: (nextExecute: AgentDecisionExecutor) =>
      createRunAgentDecisionLogic(logic.withExecutor(nextExecute), runCtx),
  }) as DecisionLogic;
}

export async function runAgent<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>
): Promise<RunAgentResult<TMachine>> {
  const maxModelCalls = options.maxModelCalls ?? 100;
  let modelCallCount = 0;
  let budgetExceeded = false;

  const consumeModelCall = () => {
    if (budgetExceeded) {
      throw new MaxModelCallsExceededError();
    }
    modelCallCount += 1;
    if (modelCallCount > maxModelCalls) {
      budgetExceeded = true;
      throw new MaxModelCallsExceededError();
    }
  };

  // §3.2 step 1: bind implementations. Conceptually `machine.provide({
  // actorSources: options.actorSources })` first, then walk the EFFECTIVE
  // (post-provide) sources (spike S4: chained provides merge).
  const provided = machine.provide({
    actorSources: options.actorSources as never,
  }) as TMachine;

  const effectiveSources = provided.implementations.actorSources as Record<
    string,
    AnyActorLogic
  >;

  assertBindable(provided, effectiveSources, {
    hasDecide: !!options.decide,
    hasStreamText: !!options.streamText,
    hasUserInput: !!options.userInput,
  });

  const actorHolder: { actorRef: AnyActorRef | undefined } = { actorRef: undefined };
  const runCtx: RunAgentBindContext = {
    generateText: options.generateText,
    streamText: options.streamText,
    decide: options.decide,
    onChunk: options.onChunk,
    onResult: options.onResult,
    consumeModelCall,
    actorHolder,
  };

  // §3.2 step 2: wrap every effective TextLogic/DecisionLogic (and the
  // agent.* builtins) with a host-backed executor. Every other source (plain
  // actors, non-agent logic) passes through untouched.
  const wrappedSources: Record<string, AnyActorLogic> = {};
  for (const [key, logic] of Object.entries(effectiveSources)) {
    if (key === USER_INPUT_ACTOR) {
      if (options.userInput) {
        const userInput = options.userInput;
        wrappedSources[key] = createAsyncLogic<unknown, AgentUserInput>({
          run: async ({ input }) => await userInput(input),
        });
      }
      continue;
    }

    if (isDecisionLogic(logic)) {
      wrappedSources[key] = createRunAgentDecisionLogic(logic, runCtx);
      continue;
    }

    if (isTextLogic(logic)) {
      wrappedSources[key] = wrapTextLogicForRunAgent(logic, runCtx);
      continue;
    }
    // Non-agent actors and already-unreachable placeholders pass through
    // untouched — assertBindable already rejected reachable placeholders.
  }

  const boundMachine = provided.provide({
    actorSources: wrappedSources as never,
  }) as TMachine;

  return new Promise<RunAgentResult<TMachine>>((resolvePromise) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let actor: ReturnType<typeof createActor<TMachine>>;

    const settle = (result: RunAgentResult<TMachine>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      actor.stop();
      resolvePromise(result);
    };

    const onAbort = () => {
      settle({
        status: 'error',
        cause: 'aborted',
        error: options.signal?.reason ?? new Error('Aborted'),
        snapshot: actor.getSnapshot(),
      });
    };

    const scheduleIdleCheck = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (settled) {
          return;
        }
        const current = actor.getSnapshot() as AnyMachineSnapshot;
        if (isIdleSnapshot(current)) {
          settle({
            status: 'idle',
            snapshot: current as SnapshotFrom<TMachine>,
          });
        }
      }, 0);
    };

    actor = createActor(boundMachine, {
      input: options.input as never,
      snapshot: options.snapshot,
      inspect: (event: InspectionEvent) => {
        if (
          settled
          || event.type !== '@xstate.transition'
          || (event.actorRef as unknown) !== (actor.ref as unknown)
        ) {
          return;
        }

        const snapshot = event.snapshot as AnyMachineSnapshot;

        options.onTransition?.(
          snapshot as SnapshotFrom<TMachine>,
          event.event as EventFromLogic<TMachine>
        );

        if (snapshot.status === 'done') {
          settle({
            status: 'done',
            output: snapshot.output as OutputFrom<TMachine>,
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        if (snapshot.status === 'error') {
          settle({
            status: 'error',
            cause: budgetExceeded ? 'max-model-calls' : 'machine',
            error: snapshot.error,
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        if (snapshot.status === 'stopped') {
          settle({
            status: 'error',
            cause: 'machine',
            error: new Error('Actor stopped externally.'),
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        scheduleIdleCheck();
      },
    });

    actorHolder.actorRef = actor as unknown as AnyActorRef;

    // Errors are settled via the `inspect` transition stream above (which
    // observes `snapshot.status === 'error'` regardless of subscribers).
    // Without a subscriber that has an `error` handler, xstate reports
    // machine errors as unhandled exceptions (Actor#_error) even though this
    // run already handles them — subscribe with a no-op to suppress that.
    actor.subscribe({ error: () => {} });

    if (options.signal) {
      if (options.signal.aborted) {
        settle({
          status: 'error',
          cause: 'aborted',
          error: options.signal.reason ?? new Error('Aborted'),
          snapshot: actor.getSnapshot(),
        });
        return;
      }
      options.signal.addEventListener('abort', onAbort);
    }

    actor.start();
    if (options.event) {
      actor.send(options.event as never);
    }
  });
}

function isIdleSnapshot(snapshot: AnyMachineSnapshot): boolean {
  if (snapshot.status !== 'active') {
    return false;
  }
  const childrenBusy = Object.values(snapshot.children ?? {}).some(
    (child) => (child as AnyActorRef | undefined)?.getSnapshot?.()?.status === 'active'
  );
  if (childrenBusy) {
    return false;
  }
  const hasPendingWork = getNextTransitions(snapshot).some(
    (transitionDef) =>
      transitionDef.eventType === ''
      || transitionDef.eventType.startsWith('xstate.after')
  );
  return !hasPendingWork;
}

async function executeAgentTextRequest(
  mode: AgentRequestMode,
  id: string,
  input: AgentTextRequest<any>,
  executors: AgentRequestExecutors,
  tools: AgentTools = {},
  info?: AgentRequestExecutorInfo
): Promise<{ output: unknown; raw: unknown }> {
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

  const raw = await executor(request, info);
  return { output: await normalizeGeneratorResult(raw), raw };
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

export function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors
): Promise<unknown>;
export function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors,
  options: { verbose: true }
): Promise<{ output: unknown; raw: unknown }>;
export async function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors,
  options?: { verbose?: boolean }
): Promise<unknown> {
  if ((request as AgentStepRequest).kind === 'decision') {
    throw new Error(
      "executeAgentRequest(...) is text-only. Resolve a 'decision' request with " +
        'resolveDecision(request, executors.decide, ...) instead.'
    );
  }

  const { output, raw } = await executeAgentTextRequest(
    request.mode ?? 'generate',
    request.id,
    request.input,
    executors,
    request.tools
  );

  const normalizedOutput = request.input.outputSchema
    ? validateSchemaSync(request.input.outputSchema, output)
    : output;

  return options?.verbose
    ? { output: normalizedOutput, raw }
    : normalizedOutput;
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

type AgentRequestConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = Record<string, unknown>,
> = TextLogicConfig<TInputSchema, TOutputSchema, TMetadata> & {
  mode?: AgentRequestMode;
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
> = {
  [K in keyof TRequestSchemas]: AgentRequestConfig<
    TRequestSchemas[K]['input'],
    TRequestSchemas[K]['output']
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

// ─── Co-located decisions ───
//
// Symmetric with the `requests:` block above. The key typing difference: a
// standalone `createDecisionLogic(...)` types `allowedEvents` only as
// `string[]` (it has no machine to check event names against). The
// co-located form knows `TEventSchemas` (from the same `setupAgent(...)`
// call), so `allowedEvents` is typed against `keyof TEventSchemas & string`
// — a typo'd event name is a type error. Deferred from P0 to P1 per
// docs/p0-design.md §2.3.
// NOTE: `schemas` is deliberately NOT a field of this generic interface —
// it is intersected in separately by `AgentDecisionsInput` below, computed
// directly from `TDecisionSchemas[K]` rather than threaded through a type
// parameter that's *also* used elsewhere in the same interface. When a
// single generic parameter is used in two sibling properties of a mapped
// type's value (e.g. both `schemas` and `prompt` referencing `TInputSchema`),
// TS's contextual inference for object-literal properties collapses to
// `unknown` instead of narrowing per-key. Keeping `schemas` external and
// computed from the same conditional type as the other fields' input avoids
// that collapse (mirrors how `AgentRequestInput` intersects `schemas:
// TRequestSchemas[K]` in rather than passing it through `AgentRequestConfig`).
type AgentDecisionConfig<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<NonReducibleUnknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
  DecisionLogicConfig<TInputSchema, keyof TEventSchemas & string, TMetadata>,
  'schemas'
>;

type AgentDecisionSchemaMap = Record<string, { input: StandardSchemaV1 } | undefined>;

type AgentDecisionsInput<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TDecisionSchemas extends AgentDecisionSchemaMap,
> = {
  [K in keyof TDecisionSchemas]: AgentDecisionConfig<
    TEventSchemas,
    TDecisionSchemas[K] extends { input: StandardSchemaV1 }
      ? TDecisionSchemas[K]['input']
      : StandardSchemaV1<NonReducibleUnknown>
  > & {
    schemas?: TDecisionSchemas[K];
  };
};

type DecisionActors<TDecisionSchemas extends AgentDecisionSchemaMap> = {
  [K in keyof TDecisionSchemas]: DecisionLogic<
    TDecisionSchemas[K] extends { input: StandardSchemaV1 }
      ? TDecisionSchemas[K]['input']
      : StandardSchemaV1<NonReducibleUnknown>
  >;
};

type AgentAllActors<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TDecisionSchemas extends AgentDecisionSchemaMap,
> = TActors & RequestActors<TRequestSchemas> & DecisionActors<TDecisionSchemas>;

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
  TDecisionSchemas extends AgentDecisionSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
> = {
  schemas: {
    context: TContextSchema;
    input: TInputSchema;
    output: TOutputSchema;
    meta: TMetaSchema;
  } & AgentSetupEventsSchema<TEventSchemas>;
  actorSources: SetupActors<
    AgentSetupActors<AgentAllActors<TActors, TRequestSchemas, TDecisionSchemas>>
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
  TDecisionSchemas extends AgentDecisionSchemaMap,
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
  requests?: AgentRequestInput<TRequestSchemas>;
  decisions?: AgentDecisionsInput<TEventSchemas, TDecisionSchemas>;
  actions?: NonNullable<AnySetupConfig['actions']>;
  guards?: NonNullable<AnySetupConfig['guards']>;
  delays?: NonNullable<AnySetupConfig['delays']>;
};

type SetupAgentXStateResult<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TDecisionSchemas extends AgentDecisionSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
> = SetupReturnFromConfig<
  AgentSetupXStateConfig<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TDecisionSchemas,
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
  TDecisionSchemas extends AgentDecisionSchemaMap,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetaSchema extends StandardSchemaV1,
> = Omit<
  SetupAgentXStateResult<
    TContextSchema,
    TEventSchemas,
    TActors,
    TRequestSchemas,
    TDecisionSchemas,
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
    TDecisionSchemas,
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
  readonly decisions: DecisionActors<TDecisionSchemas>;
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
  TDecisionSchemas extends AgentDecisionSchemaMap = {},
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
    TRequestSchemas,
    TDecisionSchemas
  >
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TDecisionSchemas,
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
  Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>
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
    Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>
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
  const requestActors = createRequestActors(requests);
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
  TRequestSchemas extends AgentRequestSchemaMap,
>(requests: AgentRequestInput<TRequestSchemas>): RequestActors<TRequestSchemas> {
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

function createDecisionActors<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TDecisionSchemas extends AgentDecisionSchemaMap,
>(
  decisions: AgentDecisionsInput<TEventSchemas, TDecisionSchemas>
): DecisionActors<TDecisionSchemas> {
  return Object.fromEntries(
    Object.entries(decisions).map(([key, decision]) => [
      key,
      createDecisionLogic(decision as DecisionLogicConfig<StandardSchemaV1>),
    ])
  ) as DecisionActors<TDecisionSchemas>;
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
>(
  requests: AgentRequestInput<TRequestSchemas> | undefined
): AgentRequestInput<TRequestSchemas> {
  return requests ?? ({} as AgentRequestInput<TRequestSchemas>);
}

function normalizeAgentDecisionInput<
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TDecisionSchemas extends AgentDecisionSchemaMap,
>(
  decisions: AgentDecisionsInput<TEventSchemas, TDecisionSchemas> | undefined
): AgentDecisionsInput<TEventSchemas, TDecisionSchemas> {
  return decisions ?? ({} as AgentDecisionsInput<TEventSchemas, TDecisionSchemas>);
}

/**
 * Runtime guard: a key appearing in more than one of `actors`/`requests`/
 * `decisions` is almost certainly a mistake (whichever spread applies last
 * would silently win) — fail fast with a clear message rather than let one
 * implementation shadow another.
 */
function assertNoActorKeyCollisions(
  actors: Record<string, unknown> | undefined,
  requests: Record<string, unknown>,
  decisions: Record<string, unknown>
): void {
  const seenIn = new Map<string, string>();
  const groups: [string, Record<string, unknown> | undefined][] = [
    ['actors', actors],
    ['requests', requests],
    ['decisions', decisions],
  ];

  for (const [groupName, group] of groups) {
    for (const key of Object.keys(group ?? {})) {
      const existingGroup = seenIn.get(key);
      if (existingGroup) {
        throw new Error(
          `setupAgent: key '${key}' is defined in both '${existingGroup}' and ` +
            `'${groupName}'. Each actor source key must be unique across ` +
            `'actors', 'requests', and 'decisions'.`
        );
      }
      seenIn.set(key, groupName);
    }
  }
}

function createAgentActorSources<
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TDecisionSchemas extends AgentDecisionSchemaMap,
>(
  actors: TActors | undefined,
  requestActors: RequestActors<TRequestSchemas>,
  decisionActors: DecisionActors<TDecisionSchemas>
): SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas, TDecisionSchemas>>> {
  assertNoActorKeyCollisions(
    actors as Record<string, unknown> | undefined,
    requestActors as Record<string, unknown>,
    decisionActors as Record<string, unknown>
  );

  return {
    ...builtinTextActors,
    [USER_INPUT_ACTOR]: userInputActor,
    [DECIDE_ACTOR]: createDecideActor(),
    ...actors,
    ...requestActors,
    ...decisionActors,
  } as SetupActors<AgentSetupActors<AgentAllActors<TActors, TRequestSchemas, TDecisionSchemas>>>;
}

function createAgentSetupConfig<
  TContextSchema extends StandardSchemaV1<Record<string, unknown>>,
  TEventSchemas extends Record<string, StandardSchemaV1>,
  TActors extends { [K in keyof TActors]: AnyActorLogic },
  TRequestSchemas extends AgentRequestSchemaMap,
  TDecisionSchemas extends AgentDecisionSchemaMap,
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
  actorSources: SetupActors<
    AgentSetupActors<AgentAllActors<TActors, TRequestSchemas, TDecisionSchemas>>
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
      TDecisionSchemas
    >,
    'actions' | 'guards' | 'delays'
  >
): AgentSetupXStateConfig<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TDecisionSchemas,
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
  TDecisionSchemas extends AgentDecisionSchemaMap,
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
    TRequestSchemas,
    TDecisionSchemas
  >
): SetupAgentResult<
  TContextSchema,
  TEventSchemas,
  TActors,
  TRequestSchemas,
  TDecisionSchemas,
  TInputSchema,
  TOutputSchema,
  TMetaSchema
> {
  const schemas = normalizeAgentSchemas(config);
  const requests = normalizeAgentRequestInput<TRequestSchemas>(config.requests);
  const requestActors = createRequestActors(requests);
  const decisions = normalizeAgentDecisionInput<TEventSchemas, TDecisionSchemas>(
    config.decisions
  );
  const decisionActors = createDecisionActors(decisions);
  const actorSources = createAgentActorSources(config.actors, requestActors, decisionActors);
  const setupConfig = createAgentSetupConfig<
      TContextSchema,
      TEventSchemas,
      TActors,
      TRequestSchemas,
      TDecisionSchemas,
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
    decisions: decisionActors,
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
    TDecisionSchemas,
    TInputSchema,
    TOutputSchema,
    TMetaSchema
  >;
}
