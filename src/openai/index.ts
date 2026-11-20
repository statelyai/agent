/**
 * The raw `openai` package adapter: builds the `{ generateText, streamText,
 * decide }` executor set consumed by `createAgentRuntime`/`executeAgentRequest`,
 * with no Vercel AI SDK in between. By default, calls that carry function
 * tools — a `generateText` with tools, and a `decide` under `decideMode: 'tool'`
 * — go through the Responses API, because reasoning models such as
 * `gpt-6-luna` reject function tools on Chat Completions; tool-free calls,
 * including an object-mode `decide`, stay on Chat Completions. `api: 'chat'`
 * sends everything to Chat Completions, tools included, and `api: 'responses'`
 * sends everything to the Responses API.
 *
 * `openai` is an OPTIONAL peer dependency and is imported for TYPES ONLY: the
 * client is injected, so nothing here pulls the package into a bundle at
 * runtime. Compare `@statelyai/agent/ai-sdk`, the same contract over the AI SDK.
 */
import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions.js";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from "openai/resources/responses/responses.js";
import {
  AGENT_USAGE_TOKEN_FIELDS,
  providerOutputSchema,
  getAgentOutputMode,
  parseProviderOutput,
  type AgentCallUsage,
  type AgentFinishReason,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
} from "../text-logic.js";
import { AgentTruncatedError } from "../errors.js";
import {
  renderDecisionAttempts,
  type AgentDecisionRejection,
  type AgentDecisionRequest,
} from "../decision.js";
import {
  decisionObjectSchema,
  fromDecisionObject,
  multipleCallsRejection,
  resolveDecisionMode,
  type DecisionModeOption,
} from "../internal/decision-object.js";
import { rejectedAnswer } from "../internal/rejected-answer.js";
import { withModelCalls } from "../internal/with-model-calls.js";
import type { AgentTools, ChosenEvent } from "../types.js";
import { getJsonSchema } from "../utils.js";
import {
  toAgentFinishReason,
  toChatToolChoice,
  toChatTools,
  toOpenAiCallSettings,
  toOpenAiEventTools,
  toOpenAiMessages,
  toOpenAiToolChoice,
  toOpenAiTools,
  toResponsesInput,
} from "./mappers.js";

/**
 * Messages for a decision request, with prior failed `attempts` rendered as an
 * appended user message so retries converge. Mirrors the AI SDK adapter's
 * `toDecisionMessages`.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): ChatCompletionMessageParam[] {
  const messages = toOpenAiMessages(request);
  for (const attempt of renderDecisionAttempts(request)) {
    messages.push({ role: "user", content: attempt.content as string });
  }
  return messages;
}

// ─── Result mapping ───

type OpenAiUsage = NonNullable<ChatCompletion["usage"]>;

/**
 * Folds OpenAI's usage payload onto the flat {@link AgentCallUsage} field names
 * core aggregates. OpenAI nests the reasoning count under
 * `completion_tokens_details` and the cache-read count under
 * `prompt_tokens_details`; a field the response omitted stays omitted, so it
 * never contributes a `0` to a run's partial sums.
 */
export function toAgentCallUsage(usage: OpenAiUsage | undefined): AgentCallUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

// The function calls a Responses API response asked for, in order.
function functionCalls(response: Pick<Response, "output">): ResponseFunctionToolCall[] {
  return (response.output ?? []).filter(
    (item): item is ResponseFunctionToolCall => item.type === "function_call",
  );
}

// The concatenated `output_text` of a Responses API response.
function outputText(response: Pick<Response, "output">): string {
  let text = "";
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          text += part.text;
        }
      }
    }
  }
  return text;
}

/** {@link toAgentCallUsage} for a Responses API usage payload, which names its
 * fields `input_tokens`/`output_tokens`. */
function toAgentResponseUsage(usage: ResponseUsage | null | undefined): AgentCallUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens;
  return {
    ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/**
 * The portable {@link AgentFinishReason} of a Responses API response, which has
 * no `finish_reason`: an `incomplete` status carries the reason, and a
 * completed response that asked for function calls stopped for them.
 */
function toAgentResponseFinishReason(
  response: Pick<Response, "status" | "incomplete_details" | "output">,
): AgentFinishReason {
  if (response.status === "incomplete") {
    switch (response.incomplete_details?.reason) {
      case "max_output_tokens":
        return "length";
      case "content_filter":
        return "content-filter";
      default:
        return "other";
    }
  }
  if (functionCalls(response).length > 0) {
    return "tool-calls";
  }
  return response.status === "completed" ? "stop" : "other";
}

/**
 * Throws for a `failed` Responses API response. The SDK returns one without
 * throwing, and passing it on would record an empty result as a success.
 */
function assertNotFailed(response: Response, executor: string): void {
  if (response.status === "failed") {
    throw new Error(
      `createOpenAiExecutors: ${executor} — the Responses API call failed` +
        (response.error ? ` (${response.error.code}: ${response.error.message})` : "") +
        ".",
    );
  }
}

// Sampling settings a model may reject (reasoning models reject `temperature`
// and `top_p`; older models reject `reasoning`). See `createResponse`.
const REJECTABLE_SETTINGS = ["temperature", "top_p", "top_logprobs", "reasoning"];

/** The top-level parameter an OpenAI `unsupported_parameter` 400 names, if any. */
function unsupportedParameter(error: unknown): string | undefined {
  const { status, param, message } = (error ?? {}) as {
    status?: unknown;
    param?: unknown;
    message?: unknown;
  };
  if (status !== 400) return undefined;
  const named =
    typeof param === "string"
      ? param
      : /Unsupported parameter: '([\w.]+)'/.exec(String(message))?.[1];
  return named?.split(".")[0];
}

// The Chat Completions settings the Responses API accepts under the same name.
const RESPONSES_SHARED_SETTINGS = [
  "metadata",
  "moderation",
  "parallel_tool_calls",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "store",
  "temperature",
  "top_logprobs",
  "top_p",
  "user",
];

/** Chat Completions settings `toResponsesSettings` renames onto the Responses API. */
const RESPONSES_TRANSLATED_SETTINGS = [
  "max_completion_tokens",
  "max_tokens",
  "reasoning_effort",
  "verbosity",
];

/**
 * Translates Chat Completions settings onto the Responses API: the settings it
 * shares by name pass through, `reasoning_effort` becomes `reasoning.effort`,
 * `max_completion_tokens` (or `max_tokens`) becomes `max_output_tokens`, and
 * `verbosity` becomes `text.verbosity`. Everything else is Chat-only (`seed`,
 * `stop`, `logprobs`, `prediction`, …) and is dropped with a warning, the way
 * the AI SDK's Responses provider drops what it cannot send, rather than
 * failing the call. `warned` holds the keys already warned about, so a tool
 * loop warns once per key, not once per step.
 */
function toResponsesSettings(settings: OpenAiCallSettings, warned: Set<string>) {
  const { reasoning_effort, max_completion_tokens, max_tokens, verbosity } = settings;
  const entries = Object.entries(settings).filter(([, value]) => value !== undefined);
  const shared = Object.fromEntries(
    entries.filter(([key]) => RESPONSES_SHARED_SETTINGS.includes(key)),
  );
  for (const [key] of entries) {
    if (RESPONSES_SHARED_SETTINGS.includes(key) || RESPONSES_TRANSLATED_SETTINGS.includes(key)) {
      continue;
    }
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn(
      `@statelyai/agent/openai: the Responses API has no \`${key}\` parameter, so it was dropped ` +
        `from this call. A request's \`seed\` and \`stopSequences\` map to \`seed\` and \`stop\`.`,
    );
  }
  const maxOutputTokens = max_completion_tokens ?? max_tokens;
  return {
    ...shared,
    ...(reasoning_effort != null ? { reasoning: { effort: reasoning_effort } } : {}),
    ...(maxOutputTokens != null ? { max_output_tokens: maxOutputTokens } : {}),
    ...(verbosity != null ? { text: { verbosity } } : {}),
  };
}

// ─── createOpenAiExecutors ───

/**
 * Per-call OpenAI Chat Completions parameters a host can apply on top of what
 * the machine asked for — `reasoning_effort`, `service_tier`,
 * `max_completion_tokens`, and anything else the API accepts. Typed straight
 * off the installed `openai` package, so it tracks that version instead of
 * restating its vocabulary. Calls that go through the Responses API translate
 * `reasoning_effort`, `max_completion_tokens`, and `verbosity` onto its names
 * and drop, with a warning, the settings it has no equivalent for, such as `seed`, `stop`,
 * `logprobs`, and `prediction`.
 *
 * The request's own fields are excluded: `model`, `messages`, `tools`,
 * `tool_choice`, `response_format`, `n`, and the streaming switches belong to
 * the machine and the adapter, and a host override would silently contradict
 * them.
 */
export type OpenAiCallSettings = Omit<
  Partial<ChatCompletionCreateParamsNonStreaming>,
  "model" | "messages" | "tools" | "tool_choice" | "response_format" | "n" | "stream"
>;

/**
 * Options for {@link createOpenAiExecutors}.
 *
 * `client` is the injected `OpenAI` instance — this adapter never constructs
 * one, so the API key, base URL, and transport stay the host's business.
 *
 * `resolveModel` maps a machine's model *ref* (e.g. `'ticketTriage'`) to a real
 * OpenAI model id. A machine's requests carry refs, not ids, so a raw-SDK host
 * must resolve them (the AI SDK adapter does this via its `models` map).
 * Defaults to identity, for machines that already use real ids.
 *
 * `settings` carries provider knobs that are the HOST's business rather than
 * the machine's, such as reasoning effort. Pass a map keyed by model ref to
 * give a ref a persona — `deep` thinks harder than `quick` — without the
 * machine naming a provider knob, or a function to vary settings per request
 * (`request.name` is the request's registered key; return `undefined` for the
 * defaults). Settings are merged UNDER what the request declared, so a machine
 * that set `maxOutputTokens` still wins.
 */
export type CreateOpenAiExecutorsOptions = {
  client: OpenAI;
  /**
   * Which OpenAI API the calls use. Unset (the default): calls with function
   * tools — a `generateText` with tools, a tool-mode `decide` — use the
   * Responses API, which reasoning models require for tools, and every other
   * call uses Chat Completions. `'chat'`: every call uses
   * `chat.completions.create`, tools included, for a model or gateway without
   * the Responses API. `'responses'`: every call uses `responses.create`, for a
   * host whose recorded traffic uses it.
   */
  api?: "chat" | "responses";
  /**
   * How a `decide` request is answered: `'object'` (default), one
   * structured-output object naming the event; or `'tool'`, one function tool
   * per candidate event under `tool_choice: 'required'`, with
   * `parallel_tool_calls: false` and a multi-call answer rejected. A function
   * picks per request.
   */
  decideMode?: DecisionModeOption;
  resolveModel?: (modelRef: string) => string;
  settings?:
    | Record<string, OpenAiCallSettings>
    | ((request: AgentTextRequest | AgentDecisionRequest) => OpenAiCallSettings | undefined);
};

/** Resolves the host's `settings` option for one request. */
function callSettings(
  options: CreateOpenAiExecutorsOptions,
  request: AgentTextRequest | AgentDecisionRequest,
): OpenAiCallSettings {
  const settings = options.settings;
  if (typeof settings === "function") {
    return settings(request) ?? {};
  }
  const entry = settings?.[request.model];
  if (entry === undefined) {
    return {};
  }
  if (typeof entry !== "object" || entry === null) {
    throw new Error(
      `createOpenAiExecutors: \`settings\` is keyed by model ref, so every value must be an ` +
        `object of OpenAI parameters, but '${request.model}' is a ${typeof entry}. Pass a ` +
        "function if you want one set of settings for every call.",
    );
  }
  return entry;
}

/**
 * Raw result shape from {@link OpenAiExecutors.generateText} — `result` (the
 * validated structured object for structured-output requests, or the model's
 * text otherwise) plus the call metadata. Core reads `result` and `usage`;
 * everything else flows verbatim to `createAgentRuntime`'s `onResult(request, { raw })`.
 */
export type OpenAiGenerateResult = {
  result: unknown;
  /** The model's reasoning, present only when the request opted in via
   * `includeReasoning` and the model produced it. Never enters machine
   * context/output. */
  reasoning?: string;
  /** The call's token usage, on the flat field names the runtime folds into the
   * run result's aggregated `AgentUsage`. Absent when OpenAI reported none. */
  usage?: AgentCallUsage;
  /** Why the call stopped, normalized to the portable {@link AgentFinishReason}. OpenAI's own value stays on `raw`. */
  finishReason: AgentFinishReason;
  /** OpenAI calls the tool loop made. */
  modelCalls: number;
  /** The untouched OpenAI response. */
  raw: unknown;
};

/** Raw result shape from {@link OpenAiExecutors.streamText} — the accumulated text once the stream finishes (chunks are delivered separately via `onChunk`), plus the stream's final usage/finish metadata. */
export type OpenAiStreamResult = {
  result: string;
  /** Present when the stream carried a usage chunk (the adapter asks for one via `stream_options`). */
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  /** The last chunk seen, which carries the stream's finish metadata. */
  raw: unknown;
};

/** Raw result shape from {@link OpenAiExecutors.decide} — the chosen event (or the answer's rejection) plus the call metadata, delivered per decision attempt to `onResult`. */
export type OpenAiDecideResult = (
  | { event: ChosenEvent; rejected?: undefined }
  | { event?: undefined; rejected: AgentDecisionRejection }
) & {
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  raw: unknown;
};

/** `createOpenAiExecutors` always populates all three slots (unlike the general
 * `AgentRequestExecutors`, where `streamText`/`decide` are optional), and its
 * results are concretely typed. */
export interface OpenAiExecutors {
  generateText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<OpenAiGenerateResult>;
  streamText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<OpenAiStreamResult>;
  decide: (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ) => Promise<OpenAiDecideResult>;
}

// Builds the AgentTruncatedError the adapter throws when a `'length'` finish
// reason left nothing usable. `what` names the part that was cut off.
function truncated(
  request: AgentTextRequest,
  info: AgentRequestExecutorInfo | undefined,
  partialOutput?: unknown,
  cause?: unknown,
): AgentTruncatedError {
  return new AgentTruncatedError(
    `createOpenAiExecutors: request '${request.name ?? "(unnamed)"}' hit the output token ` +
      "limit — its structured output never completed. Raise `maxOutputTokens`, shorten " +
      "the input, or ask for a smaller output schema.",
    {
      requestName: request.name ?? "(unnamed)",
      ...(info?.requestId !== undefined ? { requestId: info.requestId } : {}),
      ...(partialOutput !== undefined ? { partialOutput } : {}),
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

// The `usage` key, present only when OpenAI reported one.
function usageField(usage: AgentCallUsage | undefined): { usage?: AgentCallUsage } {
  return usage ? { usage } : {};
}

/**
 * Adds two calls' usage together, field by field. A tool loop makes several
 * OpenAI calls per request, and core folds ONE `usage` per executor result into
 * the run's totals, so the steps' usages have to be summed here or the run
 * undercounts. A field neither call reported stays absent.
 */
function addAgentCallUsage(
  total: AgentCallUsage | undefined,
  next: AgentCallUsage | undefined,
): AgentCallUsage | undefined {
  if (!total || !next) {
    return total ?? next;
  }
  const sum: AgentCallUsage = {};
  for (const field of AGENT_USAGE_TOKEN_FIELDS) {
    if (total[field] !== undefined || next[field] !== undefined) {
      sum[field] = (total[field] ?? 0) + (next[field] ?? 0);
    }
  }
  return sum;
}

/**
 * The function that runs one of the request's tools host-side, or `undefined`
 * when the tool has no `execute` (a client-side tool: the model's call is
 * handed back to the caller instead of being answered here).
 */
function toolExecutor(tools: AgentTools, name: string): ((input: unknown) => unknown) | undefined {
  const descriptor = tools[name];
  if (!descriptor) {
    return undefined;
  }
  if (typeof descriptor === "function") {
    return (input) => descriptor(input);
  }
  const execute = descriptor.execute;
  return typeof execute === "function" ? (input) => execute(input) : undefined;
}

// A tool's return value as the string an OpenAI tool message carries.
function toToolContent(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
}

/**
 * Builds the `{ generateText, streamText, decide }` executor set for the raw
 * `openai` package. Compare `createAiSdkExecutors` — same shape, different SDK
 * underneath.
 *
 * By default, calls with function tools use the Responses API, which reasoning
 * models require for tools: a tool-mode decision forces a call with
 * `tool_choice: 'required'`, one function tool per candidate event, and
 * `generateText` runs its tool loop there. Tool-free calls, an object-mode
 * decision among them, use Chat Completions. `api` pins every call to one API
 * (see {@link CreateOpenAiExecutorsOptions.api}). Structured output wraps the
 * `{ result, reasoning? }` provider output schema in a `json_schema` format on
 * either API.
 *
 * @example
 * ```ts
 * const executors = createOpenAiExecutors({
 *   client: new OpenAI(),
 *   resolveModel: () => 'gpt-6-luna',
 * });
 * const result = await runToQuiescence(createAgentRuntime(machine, { executors }), { input });
 * ```
 */
export function createOpenAiExecutors(options: CreateOpenAiExecutorsOptions): OpenAiExecutors {
  const { client, api, resolveModel = (modelRef: string) => modelRef } = options;
  const warnedSettings = new Set<string>();
  // Resolved model id → the settings it rejected. A model learns each rejected
  // setting once; later calls to it leave the setting out.
  const rejectedSettings = new Map<string, Set<string>>();

  // `client.responses.create`, minus the sampling settings the model rejects.
  // OpenAI answers a setting a model does not support (`temperature` on a
  // reasoning model) with a 400 rather than ignoring it, so the first such 400
  // drops that setting for the model, warns once, and retries without it.
  const createResponse = async (
    params: ResponseCreateParamsNonStreaming,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const rejected = rejectedSettings.get(params.model as string) ?? new Set<string>();
    const sent = Object.fromEntries(
      Object.entries(params).filter(([key]) => !rejected.has(key)),
    ) as ResponseCreateParamsNonStreaming;
    try {
      return (await client.responses.create(sent, { signal })) as Response;
    } catch (error) {
      const param = unsupportedParameter(error);
      if (param === undefined || !REJECTABLE_SETTINGS.includes(param) || !(param in sent)) {
        throw error;
      }
      rejectedSettings.set(params.model as string, rejected.add(param));
      console.warn(
        `@statelyai/agent/openai: \`${params.model}\` does not support \`${param}\`, so it is ` +
          `dropped from this executor's calls to that model.`,
      );
      return createResponse(params, signal);
    }
  };

  // Params every Responses API call shares. Host `settings` sit UNDER the
  // request's own settings, which are `defined()`-filtered so an unset request
  // field can never erase a host one. `store: false` matches Chat Completions,
  // which keeps nothing unless asked; a host can still set `store: true`.
  // `model`/`input` are written first and are not settable, so the cast only
  // re-asserts what the spreads preserve.
  const responsesParams = (
    request: AgentTextRequest | AgentDecisionRequest,
    input: ResponseInputItem[],
    extra: Partial<ResponseCreateParamsNonStreaming>,
  ): ResponseCreateParamsNonStreaming => {
    const settings = toResponsesSettings(
      {
        ...callSettings(options, request),
        ...toOpenAiCallSettings(request),
      },
      warnedSettings,
    );
    return {
      model: resolveModel(request.model),
      input,
      store: false,
      ...settings,
      ...extra,
      ...(settings.text || extra.text ? { text: { ...settings.text, ...extra.text } } : {}),
    } as ResponseCreateParamsNonStreaming;
  };

  // The JSON Schema for the `{ result, reasoning? }` provider output, or `undefined`
  // when the request's schema doesn't expose the `~standard.jsonSchema`
  // extension — in which case the call falls back to plain text.
  const structuredSchema = async (request: AgentTextRequest) => {
    if (getAgentOutputMode(request.outputSchema) !== "structured") {
      return undefined;
    }
    // The structured-output contract (see docs/hosts.md): send the declared
    // schema wrapped as `{ result, reasoning? }` — a root object is universally
    // accepted — and return the parsed `result`, which the machine validates
    // against the bare schema it declared.
    return getJsonSchema(
      providerOutputSchema(request.outputSchema!, { reasoning: request.includeReasoning }),
    );
  };

  type TextCallOutcome = {
    content: string | null | undefined;
    finishReason: AgentFinishReason;
    usage: AgentCallUsage | undefined;
    modelCalls: number;
    raw: unknown;
  };

  // The JSON Schema `response_format` of a Chat Completions call.
  const chatResponseFormat = (name: string, schema: Record<string, unknown>) => ({
    response_format: {
      type: "json_schema",
      json_schema: {
        name,
        schema,
        // Arbitrary JSON Schema (e.g. from Zod) may use features outside
        // OpenAI's strict-mode subset (defaults, unions, …) — leaving strict
        // mode off keeps this general rather than requiring schema authors to
        // hand-tune for OpenAI.
        strict: false,
      },
    },
  });

  // Params every Chat Completions call shares, layered like `responsesParams`.
  const chatParams = (
    request: AgentTextRequest | AgentDecisionRequest,
    messages: ChatCompletionMessageParam[],
    extra: Record<string, unknown>,
  ): ChatCompletionCreateParamsNonStreaming =>
    ({
      model: resolveModel(request.model),
      messages,
      ...callSettings(options, request),
      ...toOpenAiCallSettings(request),
      ...extra,
    }) as ChatCompletionCreateParamsNonStreaming;

  // The host-side tool loop over Chat Completions; a tool-free call is its
  // single step. Same contract as `responsesToolLoop` below: each step that
  // comes back with tool calls runs them, appends the assistant `tool_calls`
  // message and one tool message per result, and asks again, until a step
  // with no calls, the `maxSteps` budget, or a client-side tool.
  const chatToolLoop = async (
    request: AgentTextRequest & { tools: AgentTools },
    tools: FunctionTool[],
    jsonSchema: Record<string, unknown> | undefined,
    info?: AgentRequestExecutorInfo,
  ): Promise<TextCallOutcome> => {
    const maxSteps =
      typeof request.maxSteps === "number" && Number.isFinite(request.maxSteps)
        ? Math.max(1, Math.floor(request.maxSteps))
        : 1;
    const messages = toOpenAiMessages(request);
    const toolChoice = tools.length > 0 ? toChatToolChoice(request.toolChoice) : undefined;
    let response: ChatCompletion;
    let usage: AgentCallUsage | undefined;
    let step = 0;

    try {
      for (;;) {
        step++;
        response = (await client.chat.completions.create(
          chatParams(request, [...messages], {
            ...(tools.length > 0 ? { tools: toChatTools(tools) } : {}),
            ...(jsonSchema ? chatResponseFormat("output", jsonSchema) : {}),
            // A forced choice applies to the FIRST step only, as on Responses.
            ...(step === 1 && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          }),
          { signal: info?.signal },
        )) as ChatCompletion;
        usage = addAgentCallUsage(usage, toAgentCallUsage(response.usage));

        const message = response.choices[0]?.message;
        const toolCalls = message?.tool_calls ?? [];
        // A truncated turn never runs its calls, as on Responses.
        if (
          toolCalls.length === 0 ||
          step >= maxSteps ||
          response.choices[0]?.finish_reason === "length"
        ) {
          break;
        }
        // An offered tool with no `execute` hands the call back: the loop ends.
        // A tool that was not offered is answered with an error result below.
        const offered = (name: string) =>
          Object.hasOwn(request.tools, name) && request.tools[name] !== undefined;
        if (
          toolCalls.some(
            (call) =>
              call.type !== "function" ||
              (offered(call.function.name) && !toolExecutor(request.tools, call.function.name)),
          )
        ) {
          break;
        }

        messages.push(message as ChatCompletionMessageParam);
        for (const call of toolCalls) {
          if (call.type !== "function") continue;
          const { name, arguments: args } = call.function;
          let content: string;
          try {
            if (!offered(name)) {
              throw new Error(
                `tool '${name}' was not offered; valid tools: ${Object.keys(request.tools)
                  .filter(offered)
                  .join(", ")}`,
              );
            }
            let toolInput: unknown = {};
            if (args) {
              try {
                toolInput = JSON.parse(args);
              } catch {
                throw new Error(`the arguments for tool '${name}' were not valid JSON`);
              }
            }
            content = toToolContent(await toolExecutor(request.tools, name)!(toolInput));
          } catch (error) {
            // Reported to the model as an error result, as on Responses.
            content = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
      }
    } catch (error) {
      throw withModelCalls(error, step);
    }

    const choice = response.choices[0];
    return {
      content: choice?.message.content,
      finishReason: toAgentFinishReason(choice?.finish_reason),
      usage,
      modelCalls: step,
      raw: response,
    };
  };

  // The host-side tool loop, over the Responses API; with `api: 'responses'`, a
  // tool-free call is its single step. `maxSteps` bounds the
  // number of OpenAI calls (default 1, single-step, like the AI SDK adapter):
  // each step that comes back with function calls runs them, appends the calls
  // and one `function_call_output` per result, and asks again. The loop ends on
  // a step with no function calls, on the step budget, or on a tool with no
  // `execute` — a client-side tool, whose call belongs to the caller, so the
  // result comes back with `finishReason: 'tool-calls'` and the raw response.
  // A non-finite `maxSteps` (NaN, Infinity) would never satisfy the bound
  // check below and let a model that keeps calling tools run unbounded, so
  // it falls back to the single-call default like an absent value.
  const responsesToolLoop = async (
    request: AgentTextRequest & { tools: AgentTools },
    tools: FunctionTool[],
    jsonSchema: Record<string, unknown> | undefined,
    info?: AgentRequestExecutorInfo,
  ): Promise<TextCallOutcome> => {
    const maxSteps =
      typeof request.maxSteps === "number" && Number.isFinite(request.maxSteps)
        ? Math.max(1, Math.floor(request.maxSteps))
        : 1;
    const input = toResponsesInput(toOpenAiMessages(request));
    const toolChoice = toOpenAiToolChoice(request.toolChoice);
    let response: Response;
    let usage: AgentCallUsage | undefined;
    let step = 0;

    try {
      for (;;) {
        step++;
        response = await createResponse(
          responsesParams(request, [...input], {
            ...(tools.length > 0 ? { tools } : {}),
            ...(jsonSchema
              ? {
                  // `strict: false` for the same reason as the tools above.
                  text: {
                    format: {
                      type: "json_schema",
                      name: "output",
                      schema: jsonSchema,
                      strict: false,
                    },
                  },
                }
              : {}),
            // A forced choice applies to the FIRST step only: re-sending
            // `'required'` after a tool ran would force another call every step
            // and burn the budget without ever producing an answer.
            ...(step === 1 && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          }),
          info?.signal,
        );
        assertNotFailed(response, "generateText");
        usage = addAgentCallUsage(usage, toAgentResponseUsage(response.usage));

        const calls = functionCalls(response);
        // An incomplete turn (e.g. cut off at `max_output_tokens`) never runs its
        // calls: the model did not finish deciding them. It ends the loop with
        // its finish reason, so a structured request still reports truncation.
        if (calls.length === 0 || step >= maxSteps || response.status === "incomplete") {
          break;
        }
        // An offered tool with no `execute` hands the call back: the loop ends.
        // A tool that was not offered is answered with an error result below.
        const offered = (name: string) =>
          Object.hasOwn(request.tools, name) && request.tools[name] !== undefined;
        if (calls.some((call) => offered(call.name) && !toolExecutor(request.tools, call.name))) {
          break;
        }

        // Replay the step statelessly: the model's text and calls go back without
        // their item ids, and reasoning items are left out, since with
        // `store: false` there is no stored item for an id to point at.
        const text = outputText(response);
        if (text) {
          input.push({ role: "assistant", content: text });
        }
        for (const { call_id, name, arguments: args } of calls) {
          // A zero-argument call may come back with `""`; replay it as the JSON object it means.
          input.push({ type: "function_call", call_id, name, arguments: args || "{}" });
          let output: string;
          try {
            if (!offered(name)) {
              throw new Error(
                `tool '${name}' was not offered; valid tools: ${Object.keys(request.tools)
                  .filter(offered)
                  .join(", ")}`,
              );
            }
            let toolInput: unknown = {};
            if (args) {
              try {
                toolInput = JSON.parse(args);
              } catch {
                throw new Error(`the arguments for tool '${name}' were not valid JSON`);
              }
            }
            output = toToolContent(await toolExecutor(request.tools, name)!(toolInput));
          } catch (error) {
            // A thrown tool, a tool that was not offered, or arguments that are
            // not JSON go back to the model as an error result, the way the AI
            // SDK's loop reports them, rather than failing the request.
            output = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          input.push({ type: "function_call_output", call_id, output });
        }
      }
    } catch (error) {
      throw withModelCalls(error, step);
    }

    return {
      content: outputText(response),
      finishReason: toAgentResponseFinishReason(response),
      usage,
      modelCalls: step,
      raw: response,
    };
  };

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiGenerateResult> => {
    const jsonSchema = await structuredSchema(request);
    const tools = toOpenAiTools(request.tools);
    const { content, finishReason, usage, modelCalls, raw } =
      api === "responses" || (api === undefined && tools.length > 0)
        ? await responsesToolLoop(request, tools, jsonSchema, info)
        : await chatToolLoop(request, tools, jsonSchema, info);

    try {
      if (jsonSchema) {
        // A structured request that ran out of tokens has no usable output: the
        // JSON object never closed, and even a closed one only closed because the
        // model stopped mid-thought. Either way, not a final answer for a
        // machine — `partialOutput` carries whatever text did arrive.
        if (finishReason === "length") {
          throw truncated(request, info, content || undefined);
        }
        // Validated parse of the `{ result, reasoning? }` provider output — no cast.
        const parsed = parseProviderOutput(request, content ? JSON.parse(content) : undefined);
        return {
          result: parsed.result,
          ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
          ...usageField(usage),
          finishReason,
          modelCalls,
          raw,
        };
      }
    } catch (error) {
      throw withModelCalls(error, modelCalls);
    }

    // A text request that ran out of tokens still has its text. It comes back
    // with `finishReason: 'length'` — the machine decides what that is worth.
    return {
      result: content ?? "",
      ...usageField(usage),
      finishReason,
      modelCalls,
      raw,
    };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiStreamResult> => {
    // Text-only by design: no tools, no `response_format`. A chunk-by-chunk
    // structured object has nothing useful to hand `onChunk` mid-stream, so
    // a request that needs either is refused rather than silently downgraded
    // to unstructured text.
    if (getAgentOutputMode(request.outputSchema) === "structured") {
      throw new Error(
        "createOpenAiExecutors: streamText is text-only \u2014 a request declaring a structured " +
          "output schema must be routed to generateText.",
      );
    }
    if (Object.keys(request.tools ?? {}).length > 0) {
      throw new Error(
        "createOpenAiExecutors: streamText is text-only \u2014 a request declaring tools must be " +
          "routed to generateText.",
      );
    }

    if (api === "responses") {
      const events = (await client.responses.create(
        {
          ...responsesParams(request, toResponsesInput(toOpenAiMessages(request)), {}),
          stream: true,
        },
        { signal: info?.signal },
      )) as AsyncIterable<ResponseStreamEvent>;
      let text = "";
      let response: Response | undefined;
      for await (const event of events) {
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          info?.onChunk?.(event.delta);
        } else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        ) {
          response = event.response;
        }
      }
      if (response) {
        assertNotFailed(response, "streamText");
      }
      return {
        result: text,
        ...usageField(toAgentResponseUsage(response?.usage)),
        finishReason: response ? toAgentResponseFinishReason(response) : "other",
        raw: response,
      };
    }

    const stream = (await client.chat.completions.create(
      {
        model: resolveModel(request.model),
        messages: toOpenAiMessages(request),
        ...callSettings(options, request),
        ...toOpenAiCallSettings(request),
        stream: true,
        // Chat Completions omits usage from a stream unless asked, so ask —
        // it arrives on a final chunk with no choices.
        stream_options: { include_usage: true },
      } as ChatCompletionCreateParamsStreaming,
      { signal: info?.signal },
    )) as AsyncIterable<ChatCompletionChunk>;

    let text = "";
    let finishReason: AgentFinishReason = "other";
    let usage: OpenAiUsage | undefined;
    let last: ChatCompletionChunk | undefined;
    for await (const chunk of stream) {
      last = chunk;
      const choice = chunk.choices[0];
      const delta = choice?.delta.content;
      if (delta) {
        text += delta;
        info?.onChunk?.(delta);
      }
      if (choice?.finish_reason) {
        finishReason = toAgentFinishReason(choice.finish_reason);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    return { result: text, ...usageField(toAgentCallUsage(usage)), finishReason, raw: last };
  };

  // A decision's answer, read from the one tool call (or the object) a
  // response carries, with the call's metadata alongside.
  type DecideMeta = Pick<OpenAiDecideResult, "usage" | "finishReason" | "raw">;
  const fromToolCalls = (
    request: AgentDecisionRequest,
    calls: Array<{ name: string; arguments: string }>,
    meta: DecideMeta,
  ): OpenAiDecideResult => {
    // An answer that names no candidate is retried, not thrown.
    const unnamed = (call?: { toolName: string; invalidJson?: boolean }): OpenAiDecideResult => ({
      rejected: rejectedAnswer(
        call,
        request.events.map((event) => event.toolName),
      ),
      ...meta,
    });
    const toolCall = calls[0];
    if (!toolCall) return unnamed();
    // A decision sends exactly one event, so a second call is retried too.
    if (calls.length > 1) {
      return { rejected: multipleCallsRejection(calls.map((call) => call.name)), ...meta };
    }
    const toolName = toolCall.name;
    const chosenEvent = request.events.find((event) => event.toolName === toolName);
    if (!chosenEvent) return unnamed({ toolName });

    let args: unknown = {};
    try {
      if (toolCall.arguments) args = JSON.parse(toolCall.arguments);
    } catch {
      return unnamed({ toolName, invalidJson: true });
    }

    return {
      // The event's own `type` is spread LAST so it always wins: a stray
      // `type` key in the model's tool input can never override the machine
      // event type.
      event: {
        ...(args && typeof args === "object" ? args : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
      ...meta,
    };
  };

  // An incomplete turn did not finish choosing, so its answer is not a choice.
  const incomplete = (reason: string | null | undefined): Error =>
    new Error(
      "createOpenAiExecutors: decide — the response was incomplete " +
        `(${reason ?? "unknown reason"}), so no event was chosen.`,
    );

  // A decision over Chat Completions: one `{ event }` object under a
  // `json_schema` response format, or one tool call under `tool_choice: 'required'`.
  const decideWithChat = async (
    request: AgentDecisionRequest,
    mode: "object" | "tool",
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiDecideResult> => {
    const response = (await client.chat.completions.create(
      chatParams(
        request,
        toDecisionMessages(request),
        mode === "object"
          ? chatResponseFormat("decision", decisionObjectSchema(request))
          : {
              tools: toChatTools(toOpenAiEventTools(request.events)),
              tool_choice: "required",
              parallel_tool_calls: false,
            },
      ),
      { signal: info?.signal },
    )) as ChatCompletion;
    const choice = response.choices[0];
    if (choice?.finish_reason === "length") throw incomplete("max_output_tokens");
    const meta: DecideMeta = {
      ...usageField(toAgentCallUsage(response.usage)),
      finishReason: toAgentFinishReason(choice?.finish_reason),
      raw: response,
    };
    if (mode === "object") {
      return { ...fromDecisionObject(request, choice?.message.content ?? ""), ...meta };
    }
    const calls = (choice?.message.tool_calls ?? []).flatMap((call) =>
      call.type === "function" ? [call.function] : [],
    );
    return fromToolCalls(request, calls, meta);
  };

  // A decision over the Responses API: the same two modes, with the object
  // under `text.format`.
  const decideWithResponses = async (
    request: AgentDecisionRequest,
    mode: "object" | "tool",
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiDecideResult> => {
    const response = await createResponse(
      responsesParams(
        request,
        toResponsesInput(toDecisionMessages(request)),
        mode === "object"
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "decision",
                  schema: decisionObjectSchema(request),
                  strict: false,
                },
              },
            }
          : {
              tools: toOpenAiEventTools(request.events),
              tool_choice: "required",
              parallel_tool_calls: false,
            },
      ),
      info?.signal,
    );
    assertNotFailed(response, "decide");
    if (response.status === "incomplete") throw incomplete(response.incomplete_details?.reason);
    const meta: DecideMeta = {
      ...usageField(toAgentResponseUsage(response.usage)),
      finishReason: toAgentResponseFinishReason(response),
      raw: response,
    };
    if (mode === "object") {
      return { ...fromDecisionObject(request, outputText(response)), ...meta };
    }
    return fromToolCalls(request, functionCalls(response), meta);
  };

  const decide = async (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiDecideResult> => {
    const mode = resolveDecisionMode(options.decideMode, request);
    // Unset `api`: only a tool-mode decision needs the Responses API.
    return api === "chat" || (api === undefined && mode === "object")
      ? decideWithChat(request, mode, info)
      : decideWithResponses(request, mode, info);
  };

  return { generateText, streamText, decide };
}

export type { DecisionMode, DecisionModeOption } from "../internal/decision-object.js";
