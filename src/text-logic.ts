import {
  createAsyncLogic,
  type AsyncActorLogic,
  type EventObject,
} from 'xstate';
import type {
  AgentMessage,
  AgentToolChoice,
  AgentTools,
  InferOutput,
  StandardSchemaV1,
} from './types.js';
import { validateSchemaSync } from './utils.js';
import type { AgentDecisionExecutor, AgentDecisionInput } from './decision.js';
import type { ChosenEvent } from './types.js';
import { executorBoundLogics, unboundPlaceholderLogics } from './internal/registry.js';

export const USER_INPUT_ACTOR = 'agent.userInput' as const;
export const GENERATE_TEXT_ACTOR = 'agent.generateText' as const;
export const STREAM_TEXT_ACTOR = 'agent.streamText' as const;
export const DECIDE_ACTOR = 'agent.decide' as const;

export type AgentRequestMode = 'generate' | 'stream';
export type AgentModelMap = Record<string, unknown>;
export type AgentModelRef<TModels extends AgentModelMap = {}> =
  [keyof TModels] extends [never] ? string : keyof TModels & string;

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

export type BuiltinAgentActors<
  TEvent extends string = string,
  TModel extends string = string,
> = {
  [GENERATE_TEXT_ACTOR]: AsyncActorLogic<unknown, AgentTextRequest>;
  [STREAM_TEXT_ACTOR]: AsyncActorLogic<unknown, AgentTextRequest>;
  [USER_INPUT_ACTOR]: AsyncActorLogic<unknown, AgentUserInput>;
  [DECIDE_ACTOR]: AsyncActorLogic<
    ChosenEvent,
    AgentDecisionInput<TEvent, Record<string, unknown>, TModel>
  >;
};

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

export const builtinTextActors = {
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

export const userInputActor = createAsyncLogic<unknown, AgentUserInput>({
  run: async () => {
    throw new Error(
      `'${USER_INPUT_ACTOR}' has no host execution. Provide an implementation ` +
        `with machine.provide({ actorSources: { '${USER_INPUT_ACTOR}': ... } }).`
    );
  },
});
unboundPlaceholderLogics.add(userInputActor);

export function parseOutput<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  output: unknown
): InferOutput<TSchema> {
  return validateSchemaSync<InferOutput<TSchema>>(
    schema as StandardSchemaV1<InferOutput<TSchema>>,
    output
  );
}

export type ResolveTextLogicValue<TValue, TInput> =
  | TValue
  | ((args: { input: TInput }) => TValue);

export function resolveTextLogicValue<TValue, TInput>(
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
  TModel extends string = string,
> {
  mode?: AgentRequestMode;
  schemas: {
    input: TInputSchema;
    output: TOutputSchema;
  };
  model: ResolveTextLogicValue<TModel, InferOutput<TInputSchema>>;
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
  TModel extends string = string,
>(
  config: TextLogicConfig<TInputSchema, TOutputSchema, TMetadata, TModel>,
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

export function isTextLogic(value: unknown): value is TextLogic {
  return (
    !!value
    && typeof value === 'object'
    && (value as TextLogic).kind === 'statelyai.textLogic'
    && typeof (value as TextLogic).request === 'function'
  );
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

export async function executeAgentTextRequest(
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

export async function normalizeGeneratorResult(result: unknown): Promise<unknown> {
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
