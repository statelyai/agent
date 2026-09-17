import { createAsyncLogic, type AsyncActorLogic, type EventObject } from "xstate";
import type {
  AgentMessage,
  AgentToolChoice,
  AgentTools,
  InferOutput,
  StandardSchemaV1,
} from "./types.js";
import { getJsonSchemaSync, validateSchemaSync } from "./utils.js";
import type { AgentDecisionExecutor, AgentDecisionInput } from "./decision.js";
import type { ChosenEvent } from "./types.js";
import { executorBoundLogics } from "./internal/registry.js";

// Well-known invoke `src` for the builtin human-input actor.
// Well-known invoke `src` for the builtin one-shot text-generation actor.
export const GENERATE_TEXT_ACTOR = "agent.generateText" as const;
// Well-known invoke `src` for the builtin streaming text-generation actor.
export const STREAM_TEXT_ACTOR = "agent.streamText" as const;
// Well-known invoke `src` for the builtin decision actor.
export const DECIDE_ACTOR = "agent.decide" as const;

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
  : keyof TModels & string;

/**
 * Portable, provider-agnostic input a text request passes to a host
 * executor (`generateText`/`streamText` on {@link AgentRequestExecutors}).
 * Built by {@link TextLogic.request} / `DecisionLogic.request` from a
 * `TextLogicConfig`/`DecisionLogicConfig`; adapters (e.g.
 * `createAiSdkExecutors`) map this shape onto their provider's call
 * settings.
 */
export interface AgentTextRequest<TMetadata = Record<string, unknown>, TMessage = any> {
  /**
   * The registered name of the request that produced this call — the
   * `setupAgent({ requests })` key (also set by `setupAgent.fromConfig`), or
   * `TextLogicConfig.name` for standalone `createTextLogic` actors. Hosts and
   * test mocks can route on it instead of sniffing `system`/`prompt` text.
   * Absent for ad-hoc `agent.generateText`/`agent.streamText` invokes unless
   * the caller sets it on the inline input.
   */
  name?: string;
  /** The schema-validated invoke input that produced this request. */
  input?: unknown;
  model: string;
  system?: string;
  prompt?: string;
  messages?: TMessage[];
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
   *
   * Not a provider setting: reasoning EFFORT belongs to the host, which owns
   * how hard a model thinks. See `createAiSdkExecutors({ settings })`.
   */
  includeReasoning?: boolean;
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
   * Bounds the HOST-side tool-call loop for this one request: the maximum
   * number of model steps the executor may run before it must return. Omitted
   * means single-step (one model call, tool results not fed back). Named and
   * typed to match the AI SDK — the shipped adapter lowers it to
   * `stopWhen: stepCountIs(maxSteps)`.
   *
   * This is a REQUEST budget, distinct from the machine-level `maxTurns` a
   * preset uses for its own turn budget, and from `runAgent`'s run-wide
   * `maxModelCalls`.
   */
  maxSteps?: number;
  /**
   * Host-owned per-call options. Use this for provider/runtime details such
   * as Cloudflare bindings, tracing IDs, SDK provider options, or transport
   * hints. The machine carries it; the host decides what it means. Not the
   * place for `maxSteps` any more — that is a typed field above.
   */
  metadata?: TMetadata;
}

/**
 * Aggregated model-call usage for ONE `runAgent` call — the run-level total
 * attached to every settled {@link RunAgentResult} (and therefore to
 * `runAgent`'s `{ output, snapshot, persist, usage }`).
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

/**
 * Why a model call stopped, normalized across providers:
 *
 * - `'stop'` — the model finished on its own.
 * - `'length'` — the output token limit cut it off.
 * - `'tool-calls'` — it stopped to call tools.
 * - `'content-filter'` — a safety filter stopped it.
 * - `'other'` — anything else, including a provider error the adapter mapped.
 *
 * Adapters set it on their executor result; `runAgent` copies it onto the
 * `request.end` trace event. A provider's own string stays on the result's
 * `raw`.
 */
export type AgentFinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "other";

const AGENT_FINISH_REASONS = new Set<string>([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "other",
]);

/**
 * Reads a settled call's {@link AgentFinishReason} off a RAW executor result's
 * `finishReason` field — the finish-reason sibling of {@link getCallUsage},
 * applied by `runAgent` before it puts the reason on the `request.end` trace.
 * A provider's `'error'` normalizes to `'other'`; anything else the union does
 * not name (an un-normalized provider string, a missing field) returns
 * `undefined`.
 */
export function getCallFinishReason(raw: unknown): AgentFinishReason | undefined {
  const value = (raw as { finishReason?: unknown } | null | undefined)?.finishReason;
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "error") {
    return "other";
  }
  return AGENT_FINISH_REASONS.has(value) ? (value as AgentFinishReason) : undefined;
}

/** The token fields {@link AgentUsage} aggregates. @internal */
export const AGENT_USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const satisfies readonly (keyof AgentCallUsage)[];

/**
 * Reads a settled call's per-call {@link AgentCallUsage} off a RAW executor
 * result's `usage` field, keeping only finite numbers — the same normalization
 * `runAgent` applies before it delivers `'@agent.usage'`. Returns `undefined`
 * when the result reports no usage at all. Works for our `{ output, usage }`
 * envelope, for a raw Vercel AI SDK result (its `LanguageModelUsage` carries
 * the same flat field names), and for any custom executor that follows the
 * shape.
 *
 * The seam for the step-loop path, where the host holds the raw result itself:
 *
 * ```ts
 * const { output, raw } = await executeAgentRequest(effect, executors);
 * const usage = getCallUsage(raw);
 * if (usage) append({ type: AGENT_USAGE_EVENT_TYPE, usage }); // journal + transition, like any event
 * append(effect.toDoneEvent(output));
 * ```
 *
 * See "Token usage on this path" in docs/steps.md for the full loop.
 */
export function getCallUsage(raw: unknown): AgentCallUsage | undefined {
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
 * What a text request's invoke resolves to: the validated `result` (the
 * request's `outputSchema` type, or a string) and the response `messages`
 * the executor returned (empty when it returned none). Read it in `onDone`:
 *
 * ```ts
 * onDone: ({ context, output }) => ({
 *   context: {
 *     draft: output.result,
 *     messages: [...context.messages, ...output.messages],
 *   },
 * }),
 * ```
 */
export interface AgentTextResult<TOutput = unknown, TMessage = AgentMessage> {
  result: TOutput;
  /** Framework-native response messages, exactly as the executor returned them. */
  messages: TMessage[];
}

/**
 * The response messages off an executor result envelope, or none. Fields
 * holding `undefined` are dropped on the way in: SDK message objects often
 * carry optional slots as explicit `undefined` (the AI SDK's
 * `providerOptions`, for one), and the messages now travel inside the
 * invoke's done event, which the event log requires to be strict JSON.
 * @internal
 */
export function responseMessagesOf(raw: unknown): AgentMessage[] {
  const messages = (raw as { messages?: unknown } | null | undefined)?.messages;
  return Array.isArray(messages) ? (dropUndefined(messages) as AgentMessage[]) : [];
}

// Deep-copies plain objects and arrays without `undefined`-valued fields;
// every other value (strings, typed arrays, URLs, class instances) is kept as-is.
function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = dropUndefined(entry);
    }
    return out;
  }
  return value;
}

/** The three `agent.*` builtin actor logics every setupAgent-built machine registers. @internal */
export type BuiltinAgentActors<TEvent extends string = string, TModel extends string = string> = {
  [GENERATE_TEXT_ACTOR]: AsyncActorLogic<AgentTextResult, AgentTextRequest>;
  [STREAM_TEXT_ACTOR]: AsyncActorLogic<AgentTextResult, AgentTextRequest>;
  [DECIDE_ACTOR]: AsyncActorLogic<
    ChosenEvent,
    AgentDecisionInput<TEvent, Record<string, unknown>, TModel>
  >;
};

// Returns the exclusivity error message for a request that resolved both a
// non-empty `prompt` and a non-empty `messages` array, or `undefined` when the
// request is fine. Shared by `agentTextInputSchema` and `createTextLogic`'s
// lowering so config authors hit the same error as direct callers.
function textRequestSourceIssue(request: {
  name?: string;
  prompt?: unknown;
  messages?: unknown;
}): string | undefined {
  const hasPrompt = typeof request.prompt === "string" && request.prompt.length > 0;
  const hasMessages = Array.isArray(request.messages) && request.messages.length > 0;
  const label = request.name ? ` '${request.name}'` : "";

  if (hasPrompt && hasMessages) {
    return (
      `Agent text request${label} has both a non-empty \`prompt\` and \`messages\` — ` +
      "provide exactly one so the model has a single input source."
    );
  }
  if (!hasPrompt && !hasMessages) {
    return (
      `Agent text request${label} has neither a non-empty \`prompt\` nor \`messages\` — ` +
      "provide at least one so the model has something to respond to."
    );
  }
  return undefined;
}

// Input schema for the `agent.generateText`/`agent.streamText` builtins: an
// object with a string `model` AND exactly one input source — a non-empty
// `prompt` or a non-empty `messages` array — so the model is never called with
// nothing to respond to, and never with two competing sources.
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
      const issue = textRequestSourceIssue(request);
      if (issue) {
        return { issues: [{ message: issue }] };
      }
      return { value: request };
    },
  },
};

// Accepts anything and returns it untouched. Serves two roles that differ only
// in the type they assert: `agent.generateText`'s builtin output type, and the
// default input schema of a text request that declares none (typed `undefined`
// so `input` is not required at the invoke site).
const passthroughSchema: StandardSchemaV1<never> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      return { value: value as never };
    },
  },
};

const unknownOutputSchema = passthroughSchema as StandardSchemaV1<unknown>;

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

const noInputSchema = passthroughSchema as StandardSchemaV1<undefined>;

// Builds the unbound `agent.generateText`/`agent.streamText` builtin actor logic registered by setupAgent.
function createBuiltinTextActor(
  src: typeof GENERATE_TEXT_ACTOR | typeof STREAM_TEXT_ACTOR,
  mode: AgentRequestMode,
  outputSchema: StandardSchemaV1,
): TextLogic<StandardSchemaV1<AgentTextRequest>, StandardSchemaV1> {
  const logic = createAsyncLogic<AgentTextResult, AgentTextRequest>({
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
      const { output, raw } = await executeAgentTextRequest(
        mode,
        src,
        validateSchemaSync(agentTextInputSchema, input),
        executors,
      );

      return {
        result: validateSchemaSync(outputSchema, output),
        messages: responseMessagesOf(raw),
      };
    },
    withExecutor(
      execute: TextLogicExecutor<
        StandardSchemaV1<AgentTextRequest>,
        StandardSchemaV1<unknown>,
        Record<string, unknown>
      >,
    ) {
      return createTextLogic(
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
          includeReasoning: ({ input }) => input.includeReasoning,
          temperature: ({ input }) => input.temperature,
          maxOutputTokens: ({ input }) => input.maxOutputTokens,
          topP: ({ input }) => input.topP,
          topK: ({ input }) => input.topK,
          seed: ({ input }) => input.seed,
          stopSequences: ({ input }) => input.stopSequences,
          maxSteps: ({ input }) => input.maxSteps,
          metadata: ({ input }) => input.metadata,
        },
        execute,
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
  /** Framework-native messages, passed through without conversion. */
  messages?: ResolveTextLogicValue<any[] | undefined, InferOutput<TInputSchema>>;
  tools?: ResolveTextLogicValue<AgentTools | undefined, InferOutput<TInputSchema>>;
  toolChoice?: ResolveTextLogicValue<AgentToolChoice | undefined, InferOutput<TInputSchema>>;
  /** Opt into the structured-output envelope's `reasoning` field (see {@link AgentTextRequest.includeReasoning}). */
  includeReasoning?: ResolveTextLogicValue<boolean | undefined, InferOutput<TInputSchema>>;
  temperature?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  maxOutputTokens?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topP?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topK?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  seed?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  stopSequences?: ResolveTextLogicValue<string[] | undefined, InferOutput<TInputSchema>>;
  /** Bounds this request's host-side tool loop (see {@link AgentTextRequest.maxSteps}). */
  maxSteps?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
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
> extends AsyncActorLogic<AgentTextResult<InferOutput<TOutputSchema>>, InferOutput<TInputSchema>> {
  readonly kind: "statelyai.textLogic";
  readonly mode: AgentRequestMode;
  readonly schemas: {
    readonly input: TInputSchema;
    readonly output: TOutputSchema;
  };
  request(input: InferOutput<TInputSchema>): AgentTextRequest<TMetadata>;
  /** Runs this request once against `executors`; resolves the same `{ result, messages }` the invoke's `onDone` would receive. */
  execute(
    input: InferOutput<TInputSchema>,
    executors: AgentRequestExecutors,
  ): Promise<AgentTextResult<InferOutput<TOutputSchema>>>;
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

    const name = resolveTextLogicValue(config.name, args);
    const prompt = resolveTextLogicValue(config.prompt, args);
    const messages = resolveTextLogicValue(config.messages, args);
    const sourceIssue = textRequestSourceIssue({ name, prompt, messages });

    if (sourceIssue) {
      throw new Error(sourceIssue);
    }

    return {
      name,
      input: parsedInput,
      model: resolveTextLogicValue(config.model, args)!,
      system: resolveTextLogicValue(config.system, args),
      prompt,
      messages,
      tools: resolveTextLogicValue(config.tools, args),
      toolChoice: resolveTextLogicValue(config.toolChoice, args),
      outputSchema: schemas.output,
      includeReasoning: resolveTextLogicValue(config.includeReasoning, args),
      temperature: resolveTextLogicValue(config.temperature, args),
      maxOutputTokens: resolveTextLogicValue(config.maxOutputTokens, args),
      topP: resolveTextLogicValue(config.topP, args),
      topK: resolveTextLogicValue(config.topK, args),
      seed: resolveTextLogicValue(config.seed, args),
      stopSequences: resolveTextLogicValue(config.stopSequences, args),
      maxSteps: resolveTextLogicValue(config.maxSteps, args),
      metadata: resolveTextLogicValue(config.metadata, args),
    };
  };
  const logic = createAsyncLogic<AgentTextResult<TOutput>, TInput>({
    run: async ({ input, signal, system, self }, enq) => {
      const resolvedRequest = request(input);

      if (!execute) {
        throw new Error(
          "Text logic has no host execution. Pass an executor as the second " +
            "argument to createTextLogic(...), provide a runtime adapter, or " +
            "bind it through runAgent/provideExecutors, or execute the XState effect in your host.",
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
      );

      return {
        result: validateSchemaSync<TOutput>(schemas.output, output),
        messages: responseMessagesOf(result),
      };
    },
  });

  const textLogic = Object.assign(logic, {
    kind: "statelyai.textLogic" as const,
    mode: config.mode ?? "generate",
    schemas,
    request,
    async execute(input: TInput, executors: AgentRequestExecutors) {
      const { output, raw } = await executeAgentTextRequest(
        config.mode ?? "generate",
        "textLogic",
        request(input),
        executors,
      );

      return {
        result: validateSchemaSync<TOutput>(schemas.output, output),
        messages: responseMessagesOf(raw),
      };
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
      { ...request, tools: request.tools ?? {} } as AgentExecutorTextRequest,
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
export type AgentRequestExecutorResult<TOutput = unknown, TMessage = unknown> = {
  output: TOutput;
  /** Framework-native response messages, preserved without normalization. */
  messages?: TMessage[];
  /** This call's token usage, aggregated into the run result's {@link AgentUsage}. */
  usage?: AgentCallUsage;
  /** Why this call stopped, normalized (see {@link AgentFinishReason}). Surfaced on the `request.end` trace event. */
  finishReason?: AgentFinishReason;
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
  /**
   * The `runAgent` run this call belongs to (`run_<n>`, matching trace
   * events). Undefined off the runAgent path (bare `provideExecutors` /
   * direct `TextLogic.execute`). Lets executor middleware (caching, rate
   * limits, span parenting) correlate calls without side channels.
   */
  runId?: string;
  /**
   * The durable invoke id of the request making this call (e.g.
   * `'0.(machine).asking'`) — stable across resume/replay, and it encodes the
   * invoking state, so per-state middleware can key on it. Undefined when the
   * call has no invoking actor.
   */
  requestId?: string;
  /**
   * A per-call idempotency key, `${executionId}:${requestId}#${n}` — the event
   * log's lineage id plus the occurrence of this call at this invoke site.
   * IDENTICAL across a crash re-execution: a run resumed from a log whose last
   * call was still in flight re-issues that call under the same key, so an
   * executor-level cache (or a provider's own idempotency header) can return
   * the first attempt's result instead of paying for it twice. A decision
   * retry appends its attempt ordinal (`${executionId}:${requestId}#${n}.${a}`,
   * `a` being the number of prior failed attempts), so a retry never collides
   * with the rejected attempt it is replacing.
   *
   * It identifies the CALL SITE, not the request: a fork inherits its parent's
   * lineage id, so cache on `callKey` together with a fingerprint of the
   * request and reuse a cached result only when the request also matches.
   *
   * Undefined off the `runAgent` path, and for a log with no `executionId`.
   */
  callKey?: string;
}

/**
 * The lowered request as an {@link AgentRequestExecutor} receives it: the
 * {@link AgentTextRequest} core built, with `name` resolved and the request's
 * `tools` merged in. Exactly one of `prompt`/`messages` is set.
 */
export type AgentExecutorTextRequest<TMetadata = Record<string, unknown>> = Omit<
  AgentTextRequest<TMetadata>,
  "name" | "tools"
> & {
  /** Semantic request identity; always resolved before an executor is called. */
  name: string;
  tools: AgentTools;
};

/**
 * Host implementation of one text call (`generateText` or `streamText`):
 * resolves a lowered {@link AgentExecutorTextRequest} to an `{ output }`
 * envelope (see {@link AgentRequestExecutorResult}). Adapters such as
 * `createAiSdkExecutors` and `createOpenAiExecutors` produce this shape; a
 * hand-written executor is a plain async function returning it.
 */
export type AgentRequestExecutor<
  TResult extends AgentRequestExecutorResult = AgentRequestExecutorResult,
> = (
  request: AgentExecutorTextRequest,
  info?: AgentRequestExecutorInfo,
) => TResult | PromiseLike<TResult>;

/**
 * The full set of host executors a machine's agent actors are resolved
 * with — passed to `runAgent`, `executeAgentRequest`, and
 * `TextLogic.execute`. Every slot is optional: `generateText` is needed only
 * if the machine has a `mode: 'generate'` text request, `streamText` only for
 * a `mode: 'stream'` request, and `decide` only for a decision — omitting
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
  const jsonSchema = getJsonSchemaSync(schema) as
    | { type?: unknown; [key: string]: unknown }
    | undefined;
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
  request: Pick<AgentTextRequest, "outputSchema" | "includeReasoning">,
  value: unknown,
): StructuredOutputEnvelope {
  if (!request.outputSchema) {
    throw new Error("parseStructuredEnvelope: the request declares no outputSchema.");
  }
  const envelope = buildEnvelopeSchema(request.outputSchema, {
    reasoning: request.includeReasoning,
  });
  return validateSchemaSync<StructuredOutputEnvelope>(envelope, value);
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
    name: input.name ?? id,
    tools: {
      ...input.tools,
      ...tools,
    },
  };
  const sourceIssue = textRequestSourceIssue(request);

  if (sourceIssue) {
    throw new Error(sourceIssue);
  }

  const executor = mode === "stream" ? executors.streamText : executors.generateText;

  if (!executor) {
    throw new Error(
      `No executor provided for ${mode === "stream" ? "stream" : "generate"} request '${id}'.`,
    );
  }

  // The runtime object is a plain lowered request with `tools` merged in.
  const raw = await executor(request as AgentExecutorTextRequest, info);
  return { output: await normalizeGeneratorResult(raw, id), raw };
}

/**
 * Unwraps an executor result into the request's final output: awaits and
 * returns `output` from the `{ output }` {@link AgentRequestExecutorResult}
 * envelope. Anything else is a runtime error naming `id`. This is
 * generator-result unwrapping only — decision results are extracted separately
 * by `resolveDecision`.
 *
 * @internal
 */
export async function normalizeGeneratorResult(
  result: unknown,
  id = "text request",
): Promise<unknown> {
  const resolved = await result;
  if (!resolved || typeof resolved !== "object" || !("output" in resolved)) {
    throw invalidGeneratorResult(id);
  }
  return await (resolved as { output: unknown }).output;
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
