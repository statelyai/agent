import {
  generateText as aiGenerateText,
  NoObjectGeneratedError,
  Output,
  streamText as aiStreamText,
  stepCountIs,
  type FinishReason,
  type FlexibleSchema,
  type LanguageModel,
  type ToolSet,
  type TypedToolCall,
  type TypedToolResult,
} from "ai";
import {
  buildEnvelopeSchema,
  type AgentRequestExecutor,
  type AgentRequestExecutorInfo,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type StructuredOutputEnvelope,
} from "../text-logic.js";
import type { AgentDecisionExecutor } from "../decision.js";
import type { AgentTools, ChosenEvent } from "../types.js";
import {
  extractFirstJsonValue,
  isStructuredOutputRequest,
  toAgentCallUsage,
  toAiSdkCallSettings,
  toAiSdkEventTools,
  toDecisionMessages,
  type AiSdkCallUsage,
} from "./mappers.js";

// Multi-step tool loops: the request's typed `maxSteps` bounds the AI SDK
// tool-call loop; default stays single-step. `metadata.maxSteps` is still read
// as a fallback for requests written before `maxSteps` was a typed field.
// Shared by generateText and streamText so both honor it symmetrically.
function maxStepsSetting(request: AgentTextRequest): { stopWhen?: ReturnType<typeof stepCountIs> } {
  const maxSteps =
    typeof request.maxSteps === "number" ? request.maxSteps : request.metadata?.maxSteps;
  return typeof maxSteps === "number" ? { stopWhen: stepCountIs(maxSteps) } : {};
}

// ─── createAiSdkExecutors ───

/** AI SDK model registry: maps model refs (as used in `setupAgent({ models })`/`AgentTextRequest.model`) to AI SDK `LanguageModel` values. The optional `TKey` parameter pins the ref keys (see {@link defineModels}); it defaults to `string`, so bare `AiSdkModelMap` stays `Record<string, LanguageModel>`. */
export type AiSdkModelMap<TKey extends string = string> = Record<TKey, LanguageModel>;

/**
 * Identity helper for a `models` map whose value is exported. Returns the map
 * unchanged, but types it as {@link AiSdkModelMap}`<keyof T & string>` — a
 * portable, nameable type — so an exported `const models = defineModels({...})`
 * needs no `Record<'a' | 'b', LanguageModel>` annotation and never triggers
 * TS2742 ("inferred type cannot be named without a reference to …"). The exact
 * ref keys survive, so `createAiSdkExecutors({ models })` and
 * `setupAgent({ models })` still infer/autocomplete them.
 *
 * @example
 * ```ts
 * export const models = defineModels({
 *   quick: openai('gpt-5.4-mini'),
 *   deep: openai('gpt-5.4'),
 * });
 * // typeof models === AiSdkModelMap<'quick' | 'deep'>
 * ```
 */
export function defineModels<T extends Record<string, LanguageModel>>(
  models: T,
): AiSdkModelMap<keyof T & string> {
  return models;
}

/**
 * Options for {@link createAiSdkExecutors}: either a static `models` map
 * (model refs resolved by lookup), a `resolveModel` function (refs resolved
 * dynamically, e.g. `"openai/gpt-5.4-mini"` → `openai('gpt-5.4-mini')`), or
 * both — `resolveModel` takes precedence when both are supplied.
 */
export type CreateAiSdkExecutorsOptions<TModels extends AiSdkModelMap = AiSdkModelMap> =
  | {
      models: TModels;
      resolveModel?: (modelRef: keyof TModels & string) => LanguageModel;
    }
  | {
      models?: TModels;
      resolveModel: (modelRef: string) => LanguageModel;
    };

// Resolves a text/decision request's `model` ref to an AI SDK LanguageModel via `resolveModel` (if given) or a `models` lookup.
function resolveAiSdkModel<TModels extends AiSdkModelMap>(
  options: CreateAiSdkExecutorsOptions<TModels>,
  modelRef: string,
): LanguageModel {
  if (options.resolveModel) {
    return options.resolveModel(modelRef as keyof TModels & string);
  }

  const models = options.models;
  if (!models) {
    throw new Error(`createAiSdkExecutors: no model resolver configured for '${modelRef}'.`);
  }

  const model = models[modelRef as keyof TModels & string];
  if (!model) {
    throw new Error(`createAiSdkExecutors: unknown model '${modelRef}'.`);
  }
  return model;
}

// Wraps an AI SDK Output spec so a parse failure retries once against the
// repaired text (first complete JSON value) before surfacing the original
// error. Host-side salvage — the model round-trip is not repeated.
function withJsonRepair<TOutput extends ReturnType<typeof Output.object<unknown>>>(
  output: TOutput,
): TOutput {
  return {
    ...output,
    parseCompleteOutput: async (options, context) => {
      try {
        return await output.parseCompleteOutput(options, context);
      } catch (error) {
        const repaired = extractFirstJsonValue(options.text);
        if (repaired === undefined) {
          throw error;
        }
        return await output.parseCompleteOutput({ ...options, text: repaired }, context);
      }
    },
  };
}

/**
 * Raw result shape from {@link AiSdkExecutors.generateText} — the `{ output }`
 * envelope (the validated structured object for structured-output requests,
 * or the accumulated text string otherwise; unwrapped by
 * `normalizeGeneratorResult`) plus the AI SDK call metadata. Core only reads
 * `output`; everything else flows verbatim to `runAgent`'s
 * `onResult(request, { raw })`, so `raw as AiSdkGenerateResult` is the
 * supported cast for token accounting and tracing.
 */
export type AiSdkGenerateResult = {
  output: unknown;
  /** The model's reasoning, present only when the request opted in via
   * `reasoning: true` and the model produced it (see the structured-output
   * envelope in {@link buildEnvelopeSchema}). Never enters machine context/output. */
  reasoning?: string;
  /** The call's token usage. Its flat `inputTokens`/`outputTokens`/`totalTokens`/
   * `reasoningTokens`/`cachedInputTokens` fields are what `runAgent` folds into
   * the run result's aggregated `AgentUsage`; the AI SDK's own nested
   * `inputTokenDetails`/`outputTokenDetails` and `raw` ride along untouched. */
  usage: AiSdkCallUsage;
  finishReason: FinishReason;
  toolCalls: TypedToolCall<ToolSet>[];
  toolResults: TypedToolResult<ToolSet>[];
};
/** Raw result shape from {@link AiSdkExecutors.streamText} — the `{ output }` envelope carrying the fully-accumulated text once the stream finishes (chunks are delivered separately via `onChunk`), plus the stream's final usage/finish metadata for `onResult`. */
export type AiSdkStreamResult = {
  output: string;
  /** The stream's final (awaited) usage; aggregated into the run result's `AgentUsage`. */
  usage: AiSdkCallUsage;
  finishReason: FinishReason;
};
/** Raw result shape from {@link AiSdkExecutors.decide} — the chosen event plus the AI SDK call metadata, delivered per decision attempt to `onResult`. */
export type AiSdkDecideResult = {
  event: ChosenEvent;
  /** This attempt's usage; aggregated into the run result's `AgentUsage`. */
  usage: AiSdkCallUsage;
  finishReason: FinishReason;
};

/** `createAiSdkExecutors` always populates all three slots (unlike the
 * general `AgentRequestExecutors`, where `streamText`/`decide` are optional),
 * and its `generateText`/`streamText` results are concretely typed. */
export interface AiSdkExecutors extends AgentRequestExecutors<
  AiSdkGenerateResult,
  AiSdkStreamResult
> {
  generateText: AgentRequestExecutor<AiSdkGenerateResult>;
  streamText: AgentRequestExecutor<AiSdkStreamResult>;
  decide: AgentDecisionExecutor;
}

/**
 * The canonical Vercel AI SDK adapter: builds the `{ generateText, streamText,
 * decide }` executor set consumed by `runAgent`/`executeAgentRequest`. `ai`
 * must not become a dependency of core `src/` files — this subpath is the one
 * place it's imported, and callers must supply their own model resolver so no
 * concrete provider package (e.g. `@ai-sdk/openai`) becomes a dependency here
 * either.
 *
 * @example
 * ```ts
 * const executors = createAiSdkExecutors({ models: { quick: openai('gpt-5.4-mini') } });
 * const result = await runAgent(machine, { input, executors });
 * ```
 */
export function createAiSdkExecutors<TModels extends AiSdkModelMap>(
  options: CreateAiSdkExecutorsOptions<TModels>,
): AiSdkExecutors {
  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => {
    const model = resolveAiSdkModel(options, request.model);
    const common = {
      model,
      abortSignal: info?.signal,
      ...toAiSdkCallSettings(request),
      ...maxStepsSetting(request),
    };

    if (isStructuredOutputRequest(request)) {
      // Every structured request is sent as the uniform `{ result, reasoning? }`
      // envelope — a root object is universally accepted, unlike a bare union/
      // array root. Unwrap `.result` before the machine validates the declared
      // schema; surface `reasoning` on the raw result only.
      const envelope = buildEnvelopeSchema(request.outputSchema!, {
        reasoning: request.includeReasoning,
      });
      const structuredOutput = withJsonRepair(
        Output.object({
          schema: envelope as FlexibleSchema<unknown>,
        }),
      );
      // One malformed response must not kill a run: when the output still
      // fails parsing/validation after JSON repair, the request is re-sent
      // once. (The SDK's own maxRetries covers network errors, not these.)
      // Only tool-FREE requests retry: a request carrying tools may already
      // have executed side effects in its tool loop before the final output
      // failed to parse, and re-sending would run them again.
      const canRetry = !request.tools || Object.keys(request.tools).length === 0;
      let result;
      try {
        result = await aiGenerateText({ ...common, output: structuredOutput });
      } catch (error) {
        if (!canRetry || !NoObjectGeneratedError.isInstance(error) || info?.signal?.aborted) {
          throw error;
        }
        result = await aiGenerateText({ ...common, output: structuredOutput });
      }
      const { result: output, reasoning } = result.output as StructuredOutputEnvelope;
      return {
        output,
        ...(reasoning !== undefined ? { reasoning } : {}),
        usage: toAgentCallUsage(result.usage),
        finishReason: result.finishReason,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
      } satisfies AiSdkGenerateResult;
    }

    const result = await aiGenerateText(common);
    return {
      output: result.text,
      usage: toAgentCallUsage(result.usage),
      finishReason: result.finishReason,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
    } satisfies AiSdkGenerateResult;
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => {
    const model = resolveAiSdkModel(options, request.model);
    const result = aiStreamText({
      model,
      abortSignal: info?.signal,
      ...toAiSdkCallSettings(request),
      ...maxStepsSetting(request),
    });

    for await (const chunk of result.textStream) {
      info?.onChunk?.(chunk);
    }

    return {
      output: await result.text,
      usage: toAgentCallUsage(await result.usage),
      finishReason: await result.finishReason,
    } satisfies AiSdkStreamResult;
  };

  const decide: AgentDecisionExecutor = async (request) => {
    const model = resolveAiSdkModel(options, request.model);
    const tools = toAiSdkEventTools(request.events);
    const messages = toDecisionMessages(request);

    const result = await aiGenerateText({
      model,
      abortSignal: request.signal,
      system: request.system,
      ...(messages ? { messages } : { prompt: request.prompt ?? "" }),
      tools,
      toolChoice: "required",
      stopWhen: stepCountIs(1),
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      topP: request.topP,
      topK: request.topK,
      seed: request.seed,
      stopSequences: request.stopSequences,
    });

    const toolCall = result.toolCalls[0];
    if (!toolCall) {
      throw new Error("createAiSdkExecutors: decide — model did not call an event tool.");
    }
    const chosenEvent = request.events.find((event) => event.toolName === toolCall.toolName);
    if (!chosenEvent) {
      throw new Error(
        `createAiSdkExecutors: decide — model called unknown tool '${toolCall.toolName}'.`,
      );
    }

    return {
      // The event's own `type` (from the chosen event descriptor) is spread
      // LAST so it always wins: a stray `type` key in the model's tool input
      // can never override the machine event type. Payloads are flat under the
      // event object, so a payload field named `type` is unrepresentable — the
      // event discriminant owns that slot.
      event: {
        ...(toolCall.input && typeof toolCall.input === "object" ? toolCall.input : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
      usage: toAgentCallUsage(result.usage),
      finishReason: result.finishReason,
    } satisfies AiSdkDecideResult;
  };

  return { generateText, streamText, decide };
}
