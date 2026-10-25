import {
  experimental_decide,
  generateText as aiGenerateText,
  InvalidResponseDataError,
  NoObjectGeneratedError,
  Output,
  streamText as aiStreamText,
  stepCountIs,
  type Experimental_DecisionModel,
  type FinishReason,
  type FlexibleSchema,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type TypedToolCall,
  type TypedToolResult,
} from "ai";
import type { AnyStateMachine } from "xstate";
import {
  resolveHostSettings,
  resolveModelEntry,
  resolveModelSource,
} from "../internal/model-source.js";
import {
  isStructuredOutputSchema,
  providerOutputSchema,
  type AgentFinishReason,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
  type ProviderStructuredOutput,
} from "../text-logic.js";
import { decisionOptionIds, type AgentDecisionRequest } from "../decision.js";
import {
  decisionAttemptMessages,
  defined,
  eventForToolCall,
  normalizeMaxSteps,
  toChosenEvent,
  truncated,
} from "../internal/adapter-kit.js";
import { isRecord } from "../internal/is-record.js";
import type { AgentTools, ChosenEvent } from "../types.js";
import {
  extractFirstJsonValue,
  toAgentCallUsage,
  toAgentFinishReason,
  toAiSdkCallSettings,
  toAiSdkGenerationSettings,
  toAiSdkEventTools,
  toAiSdkOptionTool,
  fromAiSdkOptionCall,
  toDecisionMessages,
  unofferedOption,
  type AiSdkCallUsage,
} from "./mappers.js";

const ADAPTER = "createAiSdkExecutors";

// Multi-step tool loops: the request's typed `maxSteps` bounds the AI SDK
// tool-call loop; default stays single-step. Shared by generateText and
// streamText so both honor it symmetrically. A `maxSteps` that is not a whole
// number of at least one (NaN, Infinity, 0, 2.5) would never equal the step
// count, so it is normalized first rather than left to run unbounded.
function maxStepsSetting(request: AgentTextRequest): { stopWhen?: ReturnType<typeof stepCountIs> } {
  const maxSteps = request.maxSteps;
  return typeof maxSteps === "number" ? { stopWhen: stepCountIs(normalizeMaxSteps(maxSteps)) } : {};
}

// ─── createAiSdkExecutors ───

/**
 * One entry in an {@link AiSdkModelMap}: a bare `LanguageModel`, a model
 * paired with the {@link AiSdkCallSettings} that ref always runs with, or an
 * AI SDK decision model. The paired form is how a host gives a ref a persona —
 * `deep` thinks harder than `quick` — without the machine naming a provider knob.
 *
 * A decision model (such as `typeSafeAi.decisionModel('jev-latest')`) answers
 * `decide` requests that carry a closed choice (`options`) through
 * `experimental_decide`. Text requests need a language model.
 */
export type AiSdkModelEntry =
  | LanguageModel
  | AiSdkDecisionModel
  | { model: LanguageModel; settings?: AiSdkCallSettings };

// A decision model object (`doDecide`, or the deprecated `doEvaluate`). A
// string entry stays a language model id.
type AiSdkDecisionModel = Exclude<Experimental_DecisionModel, string>;

function isDecisionModel(model: unknown): model is AiSdkDecisionModel {
  return (
    isRecord(model) &&
    (typeof model.doDecide === "function" || typeof model.doEvaluate === "function")
  );
}

/**
 * Splits a portable `"provider/model-id"` model ref (the convention JSON
 * workflows and registry-less hosts use, e.g. `"openai/gpt-6-luna"`) into
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

/** AI SDK model registry: maps model refs (as used in `setupAgent({ models })`/`AgentTextRequest.model`) to AI SDK `LanguageModel` values, or to `{ model, settings }` pairs. The optional `TKey` parameter pins the ref keys; it defaults to `string`, so bare `AiSdkModelMap` stays `Record<string, AiSdkModelEntry>`. */
export type AiSdkModelMap<TKey extends string = string> = Record<TKey, AiSdkModelEntry>;

/**
 * Per-call AI SDK settings a host can apply on top of what the machine asked
 * for — reasoning effort, `providerOptions`, and anything else the SDK's call
 * options accept. Typed straight off `generateText`, so it tracks the
 * installed `ai` version instead of restating its vocabulary.
 *
 * The request's own fields (`model`, `prompt`/`messages`, `tools`, and the
 * generation settings every provider shares) are excluded: those belong to the
 * machine, and a host override would silently contradict it.
 */
export type AiSdkCallSettings = Omit<
  Parameters<typeof aiGenerateText>[0],
  | "model"
  | "prompt"
  | "messages"
  | "system"
  | "instructions"
  | "tools"
  | "toolChoice"
  | "output"
  | "abortSignal"
  | "stopWhen"
>;

/**
 * Options for {@link createAiSdkExecutors}: either a static `models` map
 * (model refs resolved by lookup), a `resolveModel` function (refs resolved
 * dynamically, e.g. `"openai/gpt-6-luna"` → `openai('gpt-6-luna')`), or
 * both — `resolveModel` takes precedence when both are supplied.
 *
 * `settings` carries provider knobs that are the HOST's business rather than
 * the machine's, such as reasoning effort. Pass an object to apply it to every
 * call, or a function to vary it per request (`request.name` is the request's
 * registered key). Core neither declares nor reads these: a machine stays
 * portable, and a host that cannot honor a knob simply does not set it.
 */
export type CreateAiSdkExecutorsOptions<TModels extends AiSdkModelMap = AiSdkModelMap> = {
  settings?:
    | AiSdkCallSettings
    | ((request: AgentTextRequest | AgentDecisionRequest) => AiSdkCallSettings | undefined);
} & (
  | {
      models: TModels;
      resolveModel?: (modelRef: keyof TModels & string) => LanguageModel | AiSdkDecisionModel;
    }
  | {
      models?: TModels;
      resolveModel: (modelRef: string) => LanguageModel | AiSdkDecisionModel;
    }
);

// Resolves a text/decision request's `model` ref to an AI SDK model via `resolveModel` (if given) or a `models` lookup.
function resolveAiSdkModel<TModels extends AiSdkModelMap>(
  options: CreateAiSdkExecutorsOptions<TModels>,
  modelRef: string,
): { model: LanguageModel | AiSdkDecisionModel; settings?: AiSdkCallSettings } {
  const entry = resolveModelEntry<AiSdkModelEntry>(ADAPTER, options, modelRef);
  return isModelWithSettings(entry) ? entry : { model: entry };
}

// A text request's language model. A decision model cannot write text.
function resolveLanguageModel<TModels extends AiSdkModelMap>(
  options: CreateAiSdkExecutorsOptions<TModels>,
  request: AgentTextRequest,
): { model: LanguageModel; settings?: AiSdkCallSettings } {
  const { model, settings } = resolveAiSdkModel(options, request.model);
  if (isDecisionModel(model)) {
    throw new Error(
      `createAiSdkExecutors: model '${request.model}' is a decision model, which only answers ` +
        `decide requests with options; text request '${request.name ?? "(unnamed)"}' needs a ` +
        "language model.",
    );
  }
  return { model, ...(settings ? { settings } : {}) };
}

// A `{ model, settings }` pair, as opposed to a bare `LanguageModel`. In v7 a
// `LanguageModel` is a provider model-id string or a `LanguageModelV2`/`V3`/`V4`
// object, and none of those carries a `model` property of its own, so the key's
// presence is a safe discriminant.
function isModelWithSettings(
  entry: AiSdkModelEntry,
): entry is { model: LanguageModel; settings?: AiSdkCallSettings } {
  return typeof entry === "object" && entry !== null && "model" in entry;
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
 * Raw result shape from {@link AiSdkExecutors.generateText} — `result` (the
 * validated structured object for structured-output requests, or the
 * accumulated text string otherwise) and `messages`, plus the AI SDK call
 * metadata. Core reads `result`, `messages` and `usage`; everything else flows
 * verbatim to `createAgentRuntime`'s `onResult(request, { raw })`, so
 * `raw as AiSdkGenerateResult` is the supported cast for token accounting and
 * tracing.
 */
export type AiSdkGenerateResult = {
  result: unknown;
  /** The model's reasoning, present only when the request opted in via
   * `reasoning: true` and the model produced it (see
   * {@link providerOutputSchema}). Never enters machine context/output. */
  reasoning?: string;
  /** The call's token usage. Its flat `inputTokens`/`outputTokens`/`totalTokens`/
   * `reasoningTokens`/`cachedInputTokens` fields are what the runtime folds into
   * the run result's aggregated `AgentUsage`; the AI SDK's own nested
   * `inputTokenDetails`/`outputTokenDetails` and `raw` ride along untouched. */
  usage: AiSdkCallUsage;
  /** Why the call stopped, normalized to the portable {@link AgentFinishReason}. The SDK's own value stays on `raw`. */
  finishReason: AgentFinishReason;
  toolCalls: TypedToolCall<ToolSet>[];
  toolResults: TypedToolResult<ToolSet>[];
  /** AI SDK response messages, including tool calls/results from every step. */
  messages: ModelMessage[];
  /** The untouched AI SDK result. */
  raw: unknown;
};
/** Raw result shape from {@link AiSdkExecutors.streamText} — `result` is the fully-accumulated text once the stream finishes (chunks are delivered separately via `onChunk`), plus the response messages and the stream's final usage/finish metadata for `onResult`. */
export type AiSdkStreamResult = {
  result: string;
  /** The stream's final (awaited) usage; aggregated into the run result's `AgentUsage`. */
  usage: AiSdkCallUsage;
  /** Why the stream stopped, normalized to the portable {@link AgentFinishReason}. The SDK's own value stays on `raw`. */
  finishReason: AgentFinishReason;
  /** AI SDK response messages, including tool calls/results from every step. */
  messages: ModelMessage[];
  /** The untouched AI SDK result. */
  raw: unknown;
};
/** Raw result shape from {@link AiSdkExecutors.decide} — the chosen event plus the AI SDK call metadata, delivered per decision attempt to `onResult`. */
export type AiSdkDecideResult = {
  event: ChosenEvent;
  /** This attempt's usage; aggregated into the run result's `AgentUsage`. */
  usage: AiSdkCallUsage;
  /** `'stop'` for a decision model, which reports no finish reason. */
  finishReason: FinishReason;
  /** A decision model's confidence in the chosen option, when it reports one. */
  confidence?: number;
};

/** `createAiSdkExecutors` always populates all three slots (unlike the
 * general `AgentRequestExecutors`, where `streamText`/`decide` are optional),
 * and its `generateText`/`streamText` results are concretely typed. */
export interface AiSdkExecutors {
  generateText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<AiSdkGenerateResult>;
  streamText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<AiSdkStreamResult>;
  decide: (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ) => Promise<AiSdkDecideResult>;
}

/**
 * The canonical Vercel AI SDK adapter: builds the `{ generateText, streamText,
 * decide }` executor set consumed by `runAgent`/`createAgentRuntime`. `ai`
 * must not become a dependency of core `src/` files — this subpath is the one
 * place it's imported, and callers must supply their own model resolver so no
 * concrete provider package (e.g. `@ai-sdk/openai`) becomes a dependency here
 * either.
 *
 * Pass the options object, or pass the machine (or its `setupAgent(...)`
 * result) to reuse the `models` declared in `setupAgent({ models })`. Anything
 * else throws here, at construction.
 *
 * @example
 * ```ts
 * const agentSetup = setupAgent({ models: { quick: openai('gpt-6-luna') }, ... });
 * const machine = agentSetup.createMachine({ ... });
 * const result = await runAgent(machine, { input, executors: createAiSdkExecutors(machine) });
 * // Or explicitly: createAiSdkExecutors({ models: { quick: openai('gpt-6-luna') } })
 * ```
 */
export function createAiSdkExecutors<TModels extends AiSdkModelMap>(
  options: CreateAiSdkExecutorsOptions<TModels>,
): AiSdkExecutors;
export function createAiSdkExecutors(machine: AnyStateMachine): AiSdkExecutors;
export function createAiSdkExecutors<TModels extends AiSdkModelMap>(
  source: CreateAiSdkExecutorsOptions<TModels> | AnyStateMachine,
): AiSdkExecutors {
  const options = resolveModelSource<CreateAiSdkExecutorsOptions<TModels>>(ADAPTER, source);

  // Params generateText and streamText share. Host `settings`, then the model
  // entry's own, then the request's — each layer `defined()`-filtered or
  // built without unset keys, so an unset field never erases a layer below.
  const textParams = (
    request: AgentTextRequest & { tools: AgentTools },
    info: AgentRequestExecutorInfo | undefined,
  ) => {
    const { model, settings: modelSettings } = resolveLanguageModel(options, request);
    return {
      model,
      abortSignal: info?.signal,
      ...resolveHostSettings(options.settings, request),
      ...defined(modelSettings ?? {}),
      ...toAiSdkCallSettings(request),
      ...maxStepsSetting(request),
    };
  };

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<AiSdkGenerateResult> => {
    const common = textParams(request, info);

    if (isStructuredOutputSchema(request.outputSchema)) {
      // Every structured request is sent as `{ result, reasoning? }` — a root
      // object is universally accepted, unlike a bare union/array root. The
      // parsed `result` is what the machine validates against the declared
      // schema; `reasoning` rides along on the raw result only.
      const outputSchema = providerOutputSchema(request.outputSchema!, {
        reasoning: request.includeReasoning,
      });
      const structuredOutput = withJsonRepair(
        Output.object({
          schema: outputSchema as FlexibleSchema<unknown>,
        }),
      );
      // A structured request that ran out of tokens has no usable output: the
      // JSON object never closed. The SDK reports that either by rejecting the
      // call or by throwing when the parsed output is read, and both become an
      // AgentTruncatedError a machine can branch on.
      const result = await aiGenerateText({ ...common, output: structuredOutput }).catch(
        (error: unknown) => {
          throw NoObjectGeneratedError.isInstance(error) && error.finishReason === "length"
            ? truncated(ADAPTER, request, info, error.text, error)
            : error;
        },
      );
      const parsed = ((): ProviderStructuredOutput => {
        try {
          return result.output as ProviderStructuredOutput;
        } catch (error) {
          throw result.finishReason === "length"
            ? truncated(ADAPTER, request, info, result.text, error)
            : error;
        }
      })();
      // A structured output the model DID close, but only because it stopped
      // mid-thought, is not something to hand a machine as a final answer.
      if (result.finishReason === "length") {
        throw truncated(ADAPTER, request, info, parsed.result);
      }
      return {
        result: parsed.result,
        ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
        usage: toAgentCallUsage(result.usage),
        finishReason: toAgentFinishReason(result.finishReason),
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        messages: result.responseMessages,
        raw: result,
      } satisfies AiSdkGenerateResult;
    }

    // A text request that ran out of tokens still has its text. It comes back
    // with `finishReason: 'length'` — the machine decides what that is worth.
    const result = await aiGenerateText(common);
    return {
      result: result.text,
      usage: toAgentCallUsage(result.usage),
      finishReason: toAgentFinishReason(result.finishReason),
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      messages: result.responseMessages,
      raw: result,
    } satisfies AiSdkGenerateResult;
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => {
    const result = aiStreamText(textParams(request, info));

    for await (const chunk of result.textStream) {
      info?.onChunk?.(chunk);
    }

    return {
      result: await result.text,
      usage: toAgentCallUsage(await result.usage),
      finishReason: toAgentFinishReason(await result.finishReason),
      messages: await result.responseMessages,
      raw: result,
    } satisfies AiSdkStreamResult;
  };

  const decide = async (request: AgentDecisionRequest, info?: AgentRequestExecutorInfo) => {
    const { model, settings: modelSettings } = resolveAiSdkModel(options, request.model);
    if (isDecisionModel(model)) return decideWithDecisionModel(model, request, info);
    // A closed choice (`request.options`) is ONE tool over an enum of option
    // ids; otherwise one tool per candidate event.
    const choice = request.options ? toAiSdkOptionTool(request.options) : undefined;
    const tools = choice ? choice.tools : toAiSdkEventTools(request.events);
    const messages = toDecisionMessages(request);

    const result = await aiGenerateText({
      model,
      abortSignal: info?.signal,
      ...resolveHostSettings(options.settings, request),
      ...defined(modelSettings ?? {}),
      system: request.system,
      ...(messages ? { messages, allowSystemInMessages: true } : { prompt: request.prompt ?? "" }),
      tools,
      toolChoice: "required",
      stopWhen: stepCountIs(1),
      // Shared with the text path, so a decision cannot drift back into
      // writing these unconditionally and erasing the layers above.
      ...toAiSdkGenerationSettings(request),
    });

    const toolCall = result.toolCalls[0];
    if (choice && toolCall) {
      return {
        event: fromAiSdkOptionCall(toolCall, request.options!, choice.ids),
        usage: toAgentCallUsage(result.usage),
        finishReason: result.finishReason,
      } satisfies AiSdkDecideResult;
    }
    const chosenEvent = eventForToolCall(ADAPTER, request.events, toolCall?.toolName);

    return {
      event: toChosenEvent(chosenEvent, toolCall?.input),
      usage: toAgentCallUsage(result.usage),
      finishReason: result.finishReason,
    } satisfies AiSdkDecideResult;
  };

  return { generateText, streamText, decide };
}

// ─── Decision models ───

/** The question id a decision model's closed choice is asked under. */
const DECISION_QUESTION_ID = "next";

// Asks a decision model ONE `choice` question over the request's options: each
// option id is a label, its description the criterion (the event as JSON when
// it has none). The answer maps back to `option.event`. Host `settings` apply
// to language models only.
async function decideWithDecisionModel(
  model: AiSdkDecisionModel,
  request: AgentDecisionRequest,
  info: AgentRequestExecutorInfo | undefined,
): Promise<AiSdkDecideResult> {
  const offered = request.options;
  if (!offered?.length) {
    throw new Error(
      `createAiSdkExecutors: decision '${request.name ?? "(unnamed)"}' uses decision model ` +
        `'${request.model}', which needs a closed choice: pass \`payloads\` on agent.decide, ` +
        "or use decideNext.",
    );
  }
  const ids = decisionOptionIds(offered);
  const criteria = Object.fromEntries(
    offered.map((option, index) => [
      ids[index]!,
      option.description ?? JSON.stringify(option.event),
    ]),
  );
  // A retry carries the earlier failures, so the model can choose differently.
  const instructions = [
    [request.system, request.prompt].filter(Boolean).join("\n\n") ||
      "Which option should happen next?",
    ...decisionAttemptMessages(request).map((message) => message.content),
  ].join("\n\n");

  const ask = () =>
    experimental_decide({
      model,
      state: toDecisionState(request.input),
      questions: { [DECISION_QUESTION_ID]: { type: "choice" as const, instructions, criteria } },
      ...(info?.signal ? { abortSignal: info.signal } : {}),
    });
  let result: Awaited<ReturnType<typeof ask>>;
  try {
    result = await ask();
  } catch (error) {
    // The SDK throws on a label that is not an option; answer with an event
    // no candidate has instead, so the choice is retried.
    const chosen = unofferedChoice(error, ids);
    if (chosen === undefined) throw error;
    return decisionResult(unofferedOption(`option ${JSON.stringify(chosen)}`, ids));
  }

  const answer = result.answers[DECISION_QUESTION_ID]!;
  const option = offered[ids.indexOf(answer.choice)];
  if (!option) {
    return decisionResult(unofferedOption(`option ${JSON.stringify(answer.choice)}`, ids));
  }
  const reported = (
    result.providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined
  )?.[DECISION_QUESTION_ID];
  const confidence =
    typeof reported === "number" ? reported : answer.probabilities?.[answer.choice];
  return decisionResult(option.event, result.usage, confidence);
}

function decisionResult(
  event: ChosenEvent,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {},
  confidence?: number,
): AiSdkDecideResult {
  return {
    event,
    usage: toAgentCallUsage({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    }),
    finishReason: "stop",
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

// The label of an `InvalidResponseDataError` whose choice is not an offered id.
function unofferedChoice(error: unknown, ids: readonly string[]): string | undefined {
  if (!InvalidResponseDataError.isInstance(error) || !isRecord(error.data)) return undefined;
  const answer = error.data[DECISION_QUESTION_ID];
  const choice = isRecord(answer) ? answer.choice : undefined;
  return typeof choice === "string" && !ids.includes(choice) ? choice : undefined;
}

type JSONObject = { [key: string]: JSONValue };

// A decision model takes a string or a JSON object as its state.
function toDecisionState(value: unknown): string | JSONObject {
  if (typeof value === "string") return value;
  try {
    const json: unknown = JSON.parse(JSON.stringify(value ?? {}));
    return isRecord(json) ? (json as JSONObject) : { value: json as JSONValue };
  } catch {
    return String(value);
  }
}
