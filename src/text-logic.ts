import { createAsyncLogic, type AsyncActorLogic, type EventObject } from "xstate";
import type {
  AgentMessage,
  AgentToolChoice,
  AgentTools,
  InferOutput,
  StandardSchemaV1,
} from "./types.js";
import { validateSchemaSync } from "./utils.js";
import type {
  AgentDecisionExecutor,
  AgentDecisionInput,
  AgentPlanInput,
  PlanLogic,
} from "./decision.js";
import type { ChosenEvent } from "./types.js";
import { executorBoundLogics, unboundPlaceholderLogics } from "./internal/registry.js";

// Well-known invoke `src` for the builtin human-input actor.
export const USER_INPUT_ACTOR = "agent.userInput" as const;
// Well-known invoke `src` for the builtin one-shot text-generation actor.
export const GENERATE_TEXT_ACTOR = "agent.generateText" as const;
// Well-known invoke `src` for the builtin streaming text-generation actor.
export const STREAM_TEXT_ACTOR = "agent.streamText" as const;
// Well-known invoke `src` for the builtin decision actor.
export const DECIDE_ACTOR = "agent.decide" as const;
// Well-known invoke `src` for the builtin multi-event plan actor.
export const PLAN_ACTOR = "agent.plan" as const;

/** Synthetic `src` stamped on trace requests produced by `getRequests` state interpretation — NOT a registered actor source (nothing is invoked; the pass makes the call directly). */
export const INTERPRET_SOURCE = "agent.interpret" as const;

/** Whether a text request should be resolved with `generateText` (one-shot) or `streamText` (chunked, via `onChunk`). */
export type AgentRequestMode = "generate" | "stream";
/** A `setupAgent({ models })` model registry, mapping short model refs to provider-specific model values. */
export type AgentModelMap = Record<string, unknown>;
/**
 * A model reference: any string is legal, but a registered `models` map's keys
 * autocomplete. Refs are opaque routing keys — the host/executor (or the AI SDK
 * adapter's models map / `resolveModel`) resolves them to a real model.
 */
export type AgentModelRef<TModels extends AgentModelMap = {}> = [keyof TModels] extends [never]
  ? string
  : (keyof TModels & string) | (string & {});

/**
 * Splits a portable `"provider/model-id"` model ref (the convention JSON
 * workflows and registry-less hosts use, e.g. `"openai/gpt-5.4-mini"`) into
 * its parts. A ref with no `/` has no provider — `modelId` is the whole ref.
 * The standard building block for a host's `resolveModel`:
 *
 * @example
 * ```ts
 * const resolveModel = (ref: string) => openai(parseModelRef(ref).modelId);
 * ```
 */
export function parseModelRef(modelRef: string): {
  provider: string | undefined;
  modelId: string;
} {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: undefined, modelId: modelRef }
    : { provider: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
}

/**
 * Portable, provider-agnostic input a text request passes to a host
 * executor (`generateText`/`streamText` on {@link AgentRequestExecutors}).
 * Built by {@link TextLogic.request} / `DecisionLogic.request` from a
 * `TextLogicConfig`/`DecisionLogicConfig`; adapters (e.g.
 * `createAiSdkExecutors`) map this shape onto their provider's call
 * settings.
 */
export interface AgentTextRequest<TMetadata = Record<string, unknown>> {
  /**
   * The registered name of the request that produced this call — the
   * `setupAgent({ requests })` key (also set by `setupAgent.fromConfig`), or
   * `TextLogicConfig.name` for standalone `createTextLogic` actors. Hosts and
   * test mocks can route on it instead of sniffing `system`/`prompt` text.
   * Absent for ad-hoc `agent.generateText`/`agent.streamText` invokes unless
   * the caller sets it on the inline input.
   */
  name?: string;
  model: string;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  /** Host/model tools that are always available to this text call. */
  tools?: AgentTools;
  toolChoice?: AgentToolChoice;
  outputSchema?: StandardSchemaV1;
  /**
   * Opt-in reasoning for a structured-output request: when `true`, adapters add
   * an optional string `reasoning` property (listed BEFORE `result`) to the
   * structured-output envelope schema, nudging the model to reason before
   * committing to the result. The reasoning is surfaced on the executor's raw
   * result (never in machine context/output). Ignored for text-mode requests.
   */
  reasoning?: boolean;
  temperature?: number;
  /**
   * Maximum number of output tokens to generate. Named `maxOutputTokens` (not
   * `maxTokens`) so an `AgentTextRequest` is spread-compatible with the Vercel
   * AI SDK's `generateText`/`streamText` options.
   */
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  /**
   * Host-owned per-call options. Use this for provider/runtime details such
   * as Cloudflare bindings, tracing IDs, SDK provider options, or transport
   * hints. The machine carries it; the host decides what it means — e.g.
   * the AI SDK adapter (`createAiSdkExecutors`) reads `metadata.maxSteps` to
   * bound its multi-step tool-call loop for that request.
   */
  metadata?: TMetadata;
}

/**
 * Aggregated model-call usage for ONE `runAgent` call — the run-level total
 * attached to every settled {@link RunAgentResult} (and therefore to
 * `generateResult`'s `{ output, snapshot, events, usage }`).
 *
 * - `modelCalls` counts every model/decision call this run made (each decision
 *   retry counts separately) — the same seam `maxModelCalls` budgets. Always a
 *   number, even when no executor reported tokens.
 * - Token fields are OPTIONAL and are PARTIAL SUMS: each one sums only the
 *   calls that reported it, and stays `undefined` when NO call reported it.
 *   Executors that report nothing (custom hosts, test mocks) simply do not
 *   contribute — a run mixing reporting and non-reporting calls yields a sum
 *   over the reporting subset, not `undefined`.
 * - Aggregation is per-run: a resumed run counts only ITS OWN calls, never the
 *   history behind `snapshot`/`events`. Add prior runs' totals yourself if you
 *   want a conversation-wide figure.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  /** Model/decision calls made by this run (decision retries count separately). */
  modelCalls: number;
}

/** One model call's reported usage — {@link AgentUsage} without the run-level `modelCalls` count. What an executor puts on its result's `usage` field. */
export type AgentCallUsage = Omit<AgentUsage, "modelCalls">;

/** The token fields {@link AgentUsage} aggregates. @internal */
export const AGENT_USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const satisfies readonly (keyof AgentCallUsage)[];

/**
 * Reads a per-call {@link AgentCallUsage} off a raw executor result's `usage`
 * field, keeping only finite numbers. Returns `undefined` when the result
 * reports no usage at all. Works for our `{ output, usage }` envelope, for a
 * raw Vercel AI SDK result (its `LanguageModelUsage` carries the same flat
 * field names), and for any custom executor that follows the shape.
 *
 * @internal
 */
export function extractCallUsage(raw: unknown): AgentCallUsage | undefined {
  const usage = (raw as { usage?: unknown } | null | undefined)?.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  let out: AgentCallUsage | undefined;
  for (const field of AGENT_USAGE_TOKEN_FIELDS) {
    const value = (usage as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      (out ??= {})[field] = value;
    }
  }
  return out;
}

/**
 * Inline input for the `agent.userInput` builtin actor — a human-input request
 * (CLI prompt, chat reply, …) that resolves to the `string` the human typed.
 * See {@link RunAgentOptions.userInput}. For structured input, parse/classify
 * the string in a follow-up state, or register a custom actor source; host
 * rendering hints (a form spec, say) belong in `metadata`.
 */
export interface AgentUserInput<TMetadata = Record<string, unknown>> {
  prompt?: string;
  metadata?: TMetadata;
}

/** The five `agent.*` builtin actor logics every setupAgent-built machine registers. @internal */
export type BuiltinAgentActors<TEvent extends string = string, TModel extends string = string> = {
  [GENERATE_TEXT_ACTOR]: AsyncActorLogic<unknown, AgentTextRequest>;
  [STREAM_TEXT_ACTOR]: AsyncActorLogic<unknown, AgentTextRequest>;
  [USER_INPUT_ACTOR]: AsyncActorLogic<string, AgentUserInput>;
  [DECIDE_ACTOR]: AsyncActorLogic<
    ChosenEvent,
    AgentDecisionInput<TEvent, Record<string, unknown>, TModel>
  >;
  [PLAN_ACTOR]: PlanLogic<
    StandardSchemaV1<AgentPlanInput<TEvent, Record<string, unknown>, TModel>>
  >;
};

// Input schema for the `agent.generateText`/`agent.streamText` builtins: an
// object with a string `model` AND at least one input source — a non-empty
// `prompt` or a non-empty `messages` array — so the model is never called with
// nothing to respond to.
const agentTextInputSchema: StandardSchemaV1<AgentTextRequest> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      if (!value || typeof value !== "object") {
        return { issues: [{ message: "Expected agent text input object" }] };
      }
      const request = value as AgentTextRequest;
      if (typeof request.model !== "string") {
        return { issues: [{ message: "Expected agent text input with a string `model`" }] };
      }
      const hasPrompt = typeof request.prompt === "string" && request.prompt.length > 0;
      const hasMessages = Array.isArray(request.messages) && request.messages.length > 0;
      if (!hasPrompt && !hasMessages) {
        const label = request.name ? ` '${request.name}'` : "";
        return {
          issues: [
            {
              message:
                `Agent text request${label} has neither a non-empty \`prompt\` nor \`messages\` — ` +
                "provide at least one so the model has something to respond to.",
            },
          ],
        };
      }
      return { value: request };
    },
  },
};

// Pass-through output schema (`agent.generateText`'s builtin output type) — accepts anything.
const unknownOutputSchema: StandardSchemaV1<unknown> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      return { value };
    },
  },
};

// String output schema: `agent.streamText`'s builtin output type, and the
// default a text request's `schemas.output` falls back to when omitted.
const stringOutputSchema: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      return typeof value === "string"
        ? { value }
        : { issues: [{ message: "Expected string output" }] };
    },
  },
};

// Default input schema for a text request that declares none: accepts
// anything (so an incidental input is not an error) and types the invoke's
// `input` as `undefined`, i.e. not required at the invoke site.
const noInputSchema: StandardSchemaV1<undefined> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      return { value: value as undefined };
    },
  },
};

// Builds the unbound `agent.generateText`/`agent.streamText` builtin actor logic registered by setupAgent.
function createBuiltinTextActor(
  src: typeof GENERATE_TEXT_ACTOR | typeof STREAM_TEXT_ACTOR,
  mode: AgentRequestMode,
  outputSchema: StandardSchemaV1,
): TextLogic<StandardSchemaV1<AgentTextRequest>, StandardSchemaV1> {
  const logic = createAsyncLogic<unknown, AgentTextRequest>({
    run: async () => {
      throw new Error(
        `'${src}' has no host execution. Provide an implementation with ` +
          `machine.provide({ actors: { '${src}': ... } }) or execute the ` +
          `returned agent request with executeAgentRequest(...).`,
      );
    },
  });

  return Object.assign(logic, {
    kind: "statelyai.textLogic" as const,
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
        executors,
      );

      return validateSchemaSync(outputSchema, output);
    },
    withExecutor(
      execute: TextLogicExecutor<
        StandardSchemaV1<AgentTextRequest>,
        StandardSchemaV1<unknown>,
        Record<string, unknown>
      >,
    ) {
      return Object.assign(
        createTextLogic(
          {
            mode,
            schemas: {
              input: agentTextInputSchema,
              output: outputSchema,
            },
            name: ({ input }) => input.name,
            model: ({ input }) => input.model,
            system: ({ input }) => input.system,
            prompt: ({ input }) => input.prompt,
            messages: ({ input }) => input.messages,
            tools: ({ input }) => input.tools,
            toolChoice: ({ input }) => input.toolChoice,
            reasoning: ({ input }) => input.reasoning,
            temperature: ({ input }) => input.temperature,
            maxOutputTokens: ({ input }) => input.maxOutputTokens,
            topP: ({ input }) => input.topP,
            topK: ({ input }) => input.topK,
            seed: ({ input }) => input.seed,
            stopSequences: ({ input }) => input.stopSequences,
            metadata: ({ input }) => input.metadata,
          },
          execute,
        ),
      );
    },
  }) as TextLogic<StandardSchemaV1<AgentTextRequest>, StandardSchemaV1>;
}

/** The unbound `agent.generateText`/`agent.streamText` builtins registered by setupAgent. @internal */
export const builtinTextActors = {
  [GENERATE_TEXT_ACTOR]: createBuiltinTextActor(
    GENERATE_TEXT_ACTOR,
    "generate",
    unknownOutputSchema,
  ),
  [STREAM_TEXT_ACTOR]: createBuiltinTextActor(STREAM_TEXT_ACTOR, "stream", stringOutputSchema),
} satisfies Pick<BuiltinAgentActors, typeof GENERATE_TEXT_ACTOR | typeof STREAM_TEXT_ACTOR>;

/** The unbound `agent.userInput` builtin registered by setupAgent (an unbound-placeholder logic — see internal/registry.ts). Output is `string` — what the human typed. @internal */
export const userInputActor = createAsyncLogic<string, AgentUserInput>({
  run: async () => {
    throw new Error(
      `'${USER_INPUT_ACTOR}' has no host execution. Provide an implementation ` +
        `with machine.provide({ actors: { '${USER_INPUT_ACTOR}': ... } }).`,
    );
  },
});
unboundPlaceholderLogics.add(userInputActor);

/**
 * Validates a raw model/executor output against `schema`, returning the
 * parsed value. Thin wrapper over {@link validateSchemaSync} for parsing a
 * text request's structured output outside of `TextLogic.execute`/
 * `executeAgentRequest` (e.g. a custom host loop).
 */
export function parseOutput<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  output: unknown,
): InferOutput<TSchema> {
  return validateSchemaSync<InferOutput<TSchema>>(
    schema as StandardSchemaV1<InferOutput<TSchema>>,
    output,
  );
}

/** A TextLogicConfig/DecisionLogicConfig field value: either static, or a `({ input }) => value` resolver. @internal */
export type ResolveTextLogicValue<TValue, TInput> = TValue | ((args: { input: TInput }) => TValue);

/** Resolves a `ResolveTextLogicValue` (calls it if it's a function, else returns it as-is). @internal */
export function resolveTextLogicValue<TValue, TInput>(
  value: ResolveTextLogicValue<TValue, TInput> | undefined,
  args: { input: TInput },
): TValue | undefined {
  return typeof value === "function" ? (value as (args: { input: TInput }) => TValue)(args) : value;
}

/**
 * Config for {@link createTextLogic}: how to build an
 * {@link AgentTextRequest} from typed input, plus the input/output schemas
 * that validate it. Each request-shaping field (`model`, `system`, `prompt`,
 * …) is either a static value or a `({ input }) => value` resolver.
 */
export interface TextLogicConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<undefined>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<string>,
  TMetadata = Record<string, unknown>,
  TModel extends string = string,
> {
  mode?: AgentRequestMode;
  /** Stamped onto every lowered request as {@link AgentTextRequest.name}. `setupAgent({ requests })` sets this to the request's key. */
  name?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  /**
   * The request's input/output schemas. Both are optional:
   * - `output` defaults to a string schema (a plain text request).
   * - `input` defaults to a schema that accepts (and types) `undefined`, so
   *   the request takes no `input` at the invoke site.
   */
  schemas?: {
    input?: TInputSchema;
    output?: TOutputSchema;
  };
  model: ResolveTextLogicValue<TModel, InferOutput<TInputSchema>>;
  system?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  prompt?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  messages?: ResolveTextLogicValue<AgentMessage[] | undefined, InferOutput<TInputSchema>>;
  tools?: ResolveTextLogicValue<AgentTools | undefined, InferOutput<TInputSchema>>;
  toolChoice?: ResolveTextLogicValue<AgentToolChoice | undefined, InferOutput<TInputSchema>>;
  /** Opt into the structured-output envelope's `reasoning` field (see {@link AgentTextRequest.reasoning}). */
  reasoning?: ResolveTextLogicValue<boolean | undefined, InferOutput<TInputSchema>>;
  temperature?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  maxOutputTokens?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topP?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topK?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  seed?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  stopSequences?: ResolveTextLogicValue<string[] | undefined, InferOutput<TInputSchema>>;
  metadata?: ResolveTextLogicValue<TMetadata | undefined, InferOutput<TInputSchema>>;
}

/** Arguments passed to a {@link TextLogicExecutor}: the typed input, the lowered {@link AgentTextRequest}, and the actor's own `signal`/`system`/`self`/`emit`. */
export interface TextLogicExecuteArgs<TInput, TMetadata = Record<string, unknown>> {
  input: TInput;
  request: AgentTextRequest<TMetadata>;
  signal: AbortSignal;
  system: unknown;
  self: unknown;
  emit: (emitted: EventObject) => void;
}

/** Host implementation bound to a specific {@link TextLogic} via `withExecutor`/`createTextLogic`'s second argument — resolves one text request to an `{ output }` envelope typed from the logic's output schema (`{ output: T }`). Passthrough fields (usage, raw, …) are allowed alongside `output`. */
export type TextLogicExecutor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata = unknown,
> = (
  args: TextLogicExecuteArgs<InferOutput<TInputSchema>, TMetadata>,
) =>
  | PromiseLike<AgentRequestExecutorResult<InferOutput<TOutputSchema>>>
  | AgentRequestExecutorResult<InferOutput<TOutputSchema>>;

/**
 * Actor logic for a text request: an async effect that resolves typed input
 * to typed, schema-validated output via a model call. Built by
 * {@link createTextLogic}; register under `actors:` and invoke by name, or
 * bind an executor later with `withExecutor`. The `agent.generateText`/
 * `agent.streamText` builtins and `setupAgent({ requests })` entries are
 * both `TextLogic` under the hood.
 */
export interface TextLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata = Record<string, unknown>,
> extends AsyncActorLogic<InferOutput<TOutputSchema>, InferOutput<TInputSchema>> {
  readonly kind: "statelyai.textLogic";
  readonly mode: AgentRequestMode;
  readonly schemas: {
    readonly input: TInputSchema;
    readonly output: TOutputSchema;
  };
  request(input: InferOutput<TInputSchema>): AgentTextRequest<TMetadata>;
  execute(
    input: InferOutput<TInputSchema>,
    executors: AgentRequestExecutors,
  ): Promise<InferOutput<TOutputSchema>>;
  withExecutor(
    execute: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>,
  ): TextLogic<TInputSchema, TOutputSchema, TMetadata>;
}

/**
 * Creates reusable, standalone {@link TextLogic}: an actor that, when run,
 * resolves typed input to typed output via a model call. Register the
 * result under `actors:` and invoke it by name (equivalent to what
 * `setupAgent({ requests })` builds internally for each request entry). Pass
 * `execute` here, or bind it later with `.withExecutor(...)`, a runtime
 * adapter's `machine.provide(...)`, or `runAgent`'s `generateText`/
 * `streamText` options.
 *
 * @example
 * ```ts
 * export const tellJoke = createTextLogic({
 *   mode: 'stream',
 *   schemas: { input: z.object({ topic: z.string() }), output: z.string() },
 *   model: 'openai/gpt-5.4-mini',
 *   system: 'You tell short, punchy jokes.',
 *   prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
 * });
 * ```
 */
export function createTextLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<undefined>,
  TOutputSchema extends StandardSchemaV1 = StandardSchemaV1<string>,
  TMetadata = Record<string, unknown>,
  TModel extends string = string,
>(
  config: TextLogicConfig<TInputSchema, TOutputSchema, TMetadata, TModel>,
  execute?: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>,
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  type TInput = InferOutput<TInputSchema>;
  type TOutput = InferOutput<TOutputSchema>;
  // `schemas.input`/`schemas.output` are both optional: an omitted input takes
  // no invoke input, an omitted output is a plain string (text) request.
  const schemas = {
    input: (config.schemas?.input ?? noInputSchema) as StandardSchemaV1<TInput>,
    output: (config.schemas?.output ?? stringOutputSchema) as StandardSchemaV1<TOutput>,
  };
  const request = (input: TInput): AgentTextRequest<TMetadata> => {
    const parsedInput = validateSchemaSync<TInput>(schemas.input, input);
    const args = { input: parsedInput };

    return {
      name: resolveTextLogicValue(config.name, args),
      model: resolveTextLogicValue(config.model, args)!,
      system: resolveTextLogicValue(config.system, args),
      prompt: resolveTextLogicValue(config.prompt, args),
      messages: resolveTextLogicValue(config.messages, args),
      tools: resolveTextLogicValue(config.tools, args),
      toolChoice: resolveTextLogicValue(config.toolChoice, args),
      outputSchema: schemas.output,
      reasoning: resolveTextLogicValue(config.reasoning, args),
      temperature: resolveTextLogicValue(config.temperature, args),
      maxOutputTokens: resolveTextLogicValue(config.maxOutputTokens, args),
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
          "Text logic has no host execution. Pass an executor as the second " +
            "argument to createTextLogic(...), provide a runtime adapter, or " +
            "extract it with getAgentEffects(..., { actors }).",
        );
      }

      const result = await execute({
        input,
        request: resolvedRequest,
        signal,
        system,
        self,
        emit: enq.emit as (emitted: EventObject) => void,
      });

      const selfId = (self as { id?: unknown } | undefined)?.id;
      const output = await normalizeGeneratorResult(
        result,
        typeof selfId === "string" ? selfId : "text logic",
        { request: resolvedRequest },
      );

      return validateSchemaSync<TOutput>(schemas.output, output);
    },
  });

  const textLogic = Object.assign(logic, {
    kind: "statelyai.textLogic" as const,
    mode: config.mode ?? "generate",
    schemas,
    request,
    async execute(input: TInput, executors: AgentRequestExecutors) {
      const { output } = await executeAgentTextRequest(
        config.mode ?? "generate",
        "textLogic",
        request(input),
        executors,
      );

      return validateSchemaSync<TOutput>(schemas.output, output);
    },
    withExecutor(nextExecute: TextLogicExecutor<TInputSchema, TOutputSchema, TMetadata>) {
      return createTextLogic(config, nextExecute);
    },
  }) as TextLogic<TInputSchema, TOutputSchema, TMetadata>;

  if (execute) {
    executorBoundLogics.add(textLogic as object);
  }

  return textLogic;
}

/**
 * Binds a child machine's {@link TextLogic} to a raw
 * {@link AgentRequestExecutor} (the `generateText`/`streamText` shape hosts
 * implement). Encapsulates the `withExecutor` idiom child agents repeat:
 * default the request's `tools` to `{}`, forward the actor `signal`, call the
 * executor, and return its `{ output }` envelope. Use this to share ONE
 * executor across a parent and its nested children.
 *
 * @example
 * ```ts
 * childMachine.provide({
 *   actors: {
 *     researchTopic: bindRequestExecutor(setup.requests.researchTopic, generateText),
 *   },
 * });
 * ```
 */
export function bindRequestExecutor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  executor: AgentRequestExecutor,
  info?: Pick<AgentRequestExecutorInfo, "onChunk">,
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  return logic.withExecutor(async ({ request, signal }) => {
    const { output } = await executor(
      { ...request, tools: request.tools ?? {} } as AgentTextRequest & { tools: AgentTools },
      { signal, onChunk: info?.onChunk },
    );
    return { output } as AgentRequestExecutorResult<InferOutput<TOutputSchema>>;
  });
}

/** Type guard: true for any actor logic built by createTextLogic (checks the `kind` marker). @internal */
export function isTextLogic(value: unknown): value is TextLogic {
  return (
    !!value &&
    typeof value === "object" &&
    (value as TextLogic).kind === "statelyai.textLogic" &&
    typeof (value as TextLogic).request === "function"
  );
}

/**
 * The envelope an {@link AgentRequestExecutor} must return: `{ output }` where
 * `output` is the request's value (a text string or a structured object).
 * Passthrough fields (toolCalls, finishReason, raw, …) are allowed alongside
 * `output` and preserved on the raw result. {@link normalizeGeneratorResult}
 * unwraps `output`; a non-envelope return is a runtime error.
 *
 * `usage` is the one passthrough field core reads: report this call's tokens
 * there and `runAgent` folds them into the run's aggregated
 * {@link AgentUsage}. Optional — an executor that reports nothing still counts
 * toward `modelCalls`.
 */
export type AgentRequestExecutorResult<TOutput = unknown> = {
  output: TOutput;
  /** This call's token usage, aggregated into the run result's {@link AgentUsage}. */
  usage?: AgentCallUsage;
  [key: string]: unknown;
};

/**
 * Optional second argument passed to executors by `runAgent`. The step path
 * (`executeAgentRequest`) never passes this — chunk streaming only exists on
 * the live path, where `onChunk` (§3.1) needs a way to reach the executor.
 */
export interface AgentRequestExecutorInfo {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * A raw Vercel AI SDK `generateText` result shape: resolves `{ text }` (a
 * string or a promise of one) instead of the `{ output }`
 * {@link AgentRequestExecutorResult} envelope. Admitted directly as an executor
 * return type so `ai`'s `generateText` passes to `runAgent`/executors without a
 * cast — {@link normalizeGeneratorResult} unwraps `text` at runtime (text-only;
 * structured output is best-effort JSON parsing against the request's
 * `outputSchema`). Extra fields (`content`, `usage`, …) are ignored.
 */
export type AiSdkShapedTextResult = {
  text: string | PromiseLike<string>;
  [key: string]: unknown;
};

/**
 * A raw Vercel AI SDK `streamText` result shape: exposes a `textStream` async
 * iterable of string chunks (and, optionally, a `text` promise for the final
 * text) instead of the `{ output }` {@link AgentRequestExecutorResult} envelope.
 * Admitted directly as an executor return type so `ai`'s `streamText` passes to
 * `runAgent`/executors without a cast — {@link normalizeGeneratorResult}
 * iterates `textStream`, forwarding chunks, then resolves the final text
 * (text-only; structured output is best-effort). Extra fields are ignored.
 */
export type AiSdkShapedStreamResult = {
  textStream: AsyncIterable<string>;
  text?: PromiseLike<string>;
  [key: string]: unknown;
};

/**
 * Host implementation of one text call (`generateText` or `streamText`) —
 * resolves a lowered {@link AgentTextRequest} to an `{ output }` envelope (see
 * {@link AgentRequestExecutorResult}), unwrapped by
 * {@link normalizeGeneratorResult}. The return type is widened to also admit the
 * raw Vercel AI SDK shapes ({@link AiSdkShapedTextResult} /
 * {@link AiSdkShapedStreamResult}) so `ai`'s own `generateText`/`streamText`
 * pass through without a cast; `normalizeGeneratorResult` checks for `{ output }`
 * first, then falls back to those shapes at runtime.
 */
export type AgentRequestExecutor<
  TResult extends AgentRequestExecutorResult = AgentRequestExecutorResult,
> = (
  request: AgentTextRequest & { tools: AgentTools },
  info?: AgentRequestExecutorInfo,
) =>
  | PromiseLike<TResult | AiSdkShapedTextResult | AiSdkShapedStreamResult>
  | TResult
  | AiSdkShapedTextResult
  | AiSdkShapedStreamResult;

/**
 * The full set of host executors a machine's agent actors are resolved
 * with — passed to `runAgent`, `executeAgentRequest`, and
 * `TextLogic.execute`. Every slot is optional: `generateText` is needed only
 * if the machine has a `mode: 'generate'` text request, `streamText` only for
 * a `mode: 'stream'` request, and `decide` only for a decision/plan — omitting
 * a slot the machine actually needs is a clear bind-time error (see `runAgent`
 * and `provideExecutors`). Adapter result sets (`AiSdkExecutors`,
 * `OpenAiCompatExecutors`) re-require all three.
 */
export interface AgentRequestExecutors<
  TGenerateResult extends AgentRequestExecutorResult = AgentRequestExecutorResult,
  TStreamResult extends AgentRequestExecutorResult = AgentRequestExecutorResult,
> {
  generateText?: AgentRequestExecutor<TGenerateResult>;
  streamText?: AgentRequestExecutor<TStreamResult>;
  decide?: AgentDecisionExecutor;
}

/** Whether a text request's output is a validated structured object (`'structured'`) or plain text (`'text'`) — derived from the output schema's JSON Schema `type`. */
export type AgentOutputMode = "structured" | "text";

/**
 * Classifies a text request's output schema as `'structured'` (its JSON
 * Schema is `type: 'object'`, `type: 'array'`, or a top-level union/
 * composition — `anyOf`/`oneOf`/`allOf`, which a bare `z.union`/
 * `z.discriminatedUnion` emits with no top-level `type`) or `'text'`
 * (anything else, including no schema). Reads the schema's
 * `~standard.jsonSchema.input()` extension — schemas without it are treated
 * as `'text'`.
 */
export function getAgentOutputMode(schema?: StandardSchemaV1): AgentOutputMode {
  const jsonSchema = getStandardSchemaJson(schema);
  if (!jsonSchema) {
    return "text";
  }
  if (jsonSchema.type === "object" || jsonSchema.type === "array") {
    return "structured";
  }
  if (
    jsonSchema.type === undefined &&
    ("anyOf" in jsonSchema || "oneOf" in jsonSchema || "allOf" in jsonSchema)
  ) {
    return "structured";
  }
  return "text";
}

/** True when {@link getAgentOutputMode} classifies `schema` as `'structured'`. */
export function isStructuredOutputSchema(schema?: StandardSchemaV1): boolean {
  return getAgentOutputMode(schema) === "structured";
}

/** The unwrapped shape a {@link buildEnvelopeSchema} validate returns: the inner
 * `result` value plus, when opted in and present, the model's `reasoning`. */
export interface StructuredOutputEnvelope {
  result: unknown;
  reasoning?: string;
}

/**
 * Builds the uniform structured-output envelope schema every structured request
 * is sent to the provider as: a root object `{ result: <inner> }`, plus — when
 * `options.reasoning` is `true` — an optional string `reasoning` property listed
 * BEFORE `result` (property order nudges the model to reason first). This is THE
 * wire contract for structured output: a root object is universally accepted as
 * a provider response schema, unlike a bare union/array root that many providers
 * reject.
 *
 * The returned {@link StandardSchemaV1} validates the `{ reasoning?, result }`
 * envelope (unwrapping `result` through the original schema, capturing a string
 * `reasoning` when present) and exposes the enveloped JSON Schema. Adapters read
 * `.result` off the provider output before the machine validates it — so this is
 * transparent: user-facing output types stay the declared (un-enveloped) schema,
 * and `reasoning` is surfaced only on the raw executor result, never in machine
 * context/output.
 */
export function buildEnvelopeSchema(
  inner: StandardSchemaV1,
  options: { reasoning?: boolean } = {},
): StandardSchemaV1<StructuredOutputEnvelope> {
  const includeReasoning = options.reasoning === true;
  const buildJson = (innerJson: unknown) => ({
    type: "object",
    properties: {
      // `reasoning` is listed BEFORE `result` so property order nudges the
      // model to produce its reasoning first, then commit to the result.
      ...(includeReasoning ? { reasoning: { type: "string" } } : {}),
      result: innerJson ?? {},
    },
    required: ["result"],
    additionalProperties: false,
  });

  return {
    "~standard": {
      version: 1,
      vendor: "statelyai-agent",
      validate(value: unknown) {
        if (!value || typeof value !== "object" || !("result" in value)) {
          return { issues: [{ message: "Expected a { result } envelope object" }] };
        }
        const innerResult = inner["~standard"].validate((value as { result: unknown }).result);
        if (innerResult instanceof Promise) {
          throw new Error("Async schema validation is not supported.");
        }
        if (innerResult.issues) {
          return innerResult;
        }
        const envelope: StructuredOutputEnvelope = { result: innerResult.value };
        const reasoning = (value as { reasoning?: unknown }).reasoning;
        if (typeof reasoning === "string") {
          envelope.reasoning = reasoning;
        }
        return { value: envelope };
      },
      jsonSchema: {
        input: () => {
          const innerJson = inner["~standard"].jsonSchema?.input?.();
          return innerJson instanceof Promise ? innerJson.then(buildJson) : buildJson(innerJson);
        },
      },
    },
  } as StandardSchemaV1<StructuredOutputEnvelope>;
}

/**
 * Validates a raw provider value against the structured-output envelope for
 * `request` and returns the unwrapped `{ result, reasoning? }` — the checked
 * replacement for `raw as StructuredOutputEnvelope` in hand-written hosts.
 * Pair with {@link buildEnvelopeSchema} (which produced the schema the
 * provider was asked to satisfy).
 */
export function parseStructuredEnvelope(
  request: Pick<AgentTextRequest, "outputSchema" | "reasoning">,
  value: unknown,
): StructuredOutputEnvelope {
  if (!request.outputSchema) {
    throw new Error("parseStructuredEnvelope: the request declares no outputSchema.");
  }
  const envelope = buildEnvelopeSchema(request.outputSchema, {
    reasoning: request.reasoning,
  });
  return validateSchemaSync<StructuredOutputEnvelope>(envelope, value);
}

// Reads a schema's synchronous `~standard.jsonSchema.input()` JSON Schema, if the vendor implements that extension.
function getStandardSchemaJson(
  schema?: StandardSchemaV1,
): { type?: unknown; [key: string]: unknown } | undefined {
  const jsonSchema = (
    schema?.["~standard"] as
      | {
          jsonSchema?: { input?: () => { type?: unknown } | Promise<{ type?: unknown }> };
        }
      | undefined
  )?.jsonSchema?.input?.();

  return jsonSchema && !(jsonSchema instanceof Promise)
    ? (jsonSchema as { type?: unknown; [key: string]: unknown })
    : undefined;
}

/**
 * Merges request-declared and call-site `tools`, dispatches to the
 * `mode`-appropriate executor (`generateText`/`streamText`), and normalizes
 * the raw result via {@link normalizeGeneratorResult}. Shared by
 * `TextLogic.execute`, `executeAgentRequest`, and the `agent.generateText`/
 * `agent.streamText` builtins. Throws if no executor is registered for
 * `mode`.
 *
 * @internal
 */
export async function executeAgentTextRequest(
  mode: AgentRequestMode,
  id: string,
  input: AgentTextRequest<any>,
  executors: Partial<AgentRequestExecutors>,
  tools: AgentTools = {},
  info?: AgentRequestExecutorInfo,
): Promise<{ output: unknown; raw: unknown }> {
  const request = {
    ...input,
    tools: {
      ...input.tools,
      ...tools,
    },
  };
  const executor = mode === "stream" ? executors.streamText : executors.generateText;

  if (!executor) {
    throw new Error(
      `No executor provided for ${mode === "stream" ? "stream" : "generate"} request '${id}'.`,
    );
  }

  const raw = await executor(request, info);
  return {
    output: await normalizeGeneratorResult(raw, id, {
      request,
      onChunk: info?.onChunk,
    }),
    raw,
  };
}

/** Optional extras threaded into {@link normalizeGeneratorResult} so it can also unwrap raw AI SDK `generateText`/`streamText` results (which resolve `{ text }`/`{ textStream }` instead of `{ output }`). @internal */
export interface NormalizeGeneratorResultInfo {
  /** The lowered request — its `outputSchema` drives best-effort structured parsing of raw AI SDK text. */
  request?: AgentTextRequest<any>;
  /** Chunk sink for a raw `streamText` result's `textStream` (mirrors the `{ output }` path's `info.onChunk`). */
  onChunk?: (chunk: string) => void;
}

// True for a value that looks like an AI SDK StreamTextResult: has a `textStream` async iterable.
function hasTextStream(
  value: object,
): value is { textStream: AsyncIterable<string>; text?: unknown } {
  return (
    "textStream" in value &&
    typeof (value as { textStream?: unknown }).textStream === "object" &&
    !!(value as { textStream?: { [Symbol.asyncIterator]?: unknown } }).textStream?.[
      Symbol.asyncIterator
    ]
  );
}

// Runs a raw AI SDK final text string through the request's outputSchema (best-effort), throwing a helpful error on parse failure.
function parseRawAiSdkText(
  text: string,
  request: AgentTextRequest<any> | undefined,
  id: string,
): unknown {
  if (!request?.outputSchema) {
    return text;
  }
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Leave as the raw string; parseOutput will surface a schema error below.
  }
  try {
    return parseOutput(request.outputSchema, parsed);
  } catch (error) {
    throw new Error(
      `Executor for '${id}' returned a raw AI SDK result whose text could not be ` +
        `parsed against the request's outputSchema. Structured-output requests through ` +
        `raw AI SDK generateText/streamText functions are best-effort — for reliable ` +
        `structured output, use createAiSdkExecutors from '@statelyai/agent/ai-sdk'. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Unwraps an executor result into the request's final output. Accepts three
 * shapes:
 * - `{ output }` (the {@link AgentRequestExecutorResult} envelope) — awaits and
 *   returns `output` (the fast path; unchanged).
 * - a raw AI SDK `streamText` result (`{ textStream }` async iterable) — iterates
 *   `textStream`, forwarding each string chunk to `info.onChunk`, then resolves
 *   the final text from `await result.text` if present else the accumulated chunks.
 * - a raw AI SDK `generateText` result (`{ text }` string or promise) — awaits `text`.
 *
 * For the two raw AI SDK shapes, if `info.request?.outputSchema` is set the final
 * text is parsed through {@link parseOutput} (best-effort); a parse failure throws
 * an error recommending `createAiSdkExecutors` from '@statelyai/agent/ai-sdk'.
 *
 * A value matching none of these is a runtime error naming `id`. This is
 * generator-result unwrapping only — decision results are extracted separately
 * by `resolveDecision`.
 *
 * @internal
 */
export async function normalizeGeneratorResult(
  result: unknown,
  id = "text request",
  info?: NormalizeGeneratorResultInfo,
): Promise<unknown> {
  const resolved = await result;
  if (!resolved || typeof resolved !== "object") {
    throw invalidGeneratorResult(id);
  }

  // Fast path: our `{ output }` envelope.
  if ("output" in resolved) {
    return await (resolved as { output: unknown }).output;
  }

  // Raw AI SDK streamText result: iterate textStream, forward chunks.
  if (hasTextStream(resolved)) {
    let accumulated = "";
    for await (const chunk of resolved.textStream) {
      accumulated += chunk;
      info?.onChunk?.(chunk);
    }
    const finalText =
      "text" in resolved && resolved.text !== undefined
        ? await (resolved as { text: unknown }).text
        : accumulated;
    return parseRawAiSdkText(String(finalText), info?.request, id);
  }

  // Raw AI SDK generateText result: `text` string or promise.
  if ("text" in resolved) {
    const finalText = await (resolved as { text: unknown }).text;
    return parseRawAiSdkText(String(finalText), info?.request, id);
  }

  throw invalidGeneratorResult(id);
}

function invalidGeneratorResult(id: string): Error {
  return new Error(
    `Executor for '${id}' returned an invalid result: executors must return ` +
      `{ output } (an envelope with the text string or structured object as ` +
      `\`output\`, plus optional passthrough fields). Raw Vercel AI SDK ` +
      `generateText/streamText results ({ text } or { textStream }) are also ` +
      `accepted.`,
  );
}
