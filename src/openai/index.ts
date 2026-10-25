/**
 * The raw `openai` package adapter: builds the `{ generateText, streamText,
 * decide }` executor set consumed by `createAgentRuntime`/`executeAgentRequest`, mapped
 * onto the Chat Completions API (not `responses` — `chat.completions` is the
 * canonical/stable surface) with no Vercel AI SDK in between.
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
import {
  isStructuredOutputSchema,
  parseProviderOutput,
  providerOutputSchema,
  type AgentCallUsage,
  type AgentFinishReason,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
} from "../text-logic.js";
import type { AgentDecisionRequest } from "../decision.js";
import type { AgentTools, ChosenEvent } from "../types.js";
import { getJsonSchema } from "../utils.js";
import {
  addAgentCallUsage,
  eventForToolCall,
  fromSnakeCaseFinishReason,
  normalizeMaxSteps,
  refuseStructuredStream,
  toChosenEvent,
  truncated,
  usageField,
} from "../internal/adapter-kit.js";
import {
  toAgentCallUsage,
  toDecisionMessages,
  toOpenAiCallSettings,
  toOpenAiEventTools,
  toOpenAiMessages,
  toOpenAiToolChoice,
  toOpenAiTools,
  type OpenAiUsage,
} from "./mappers.js";

const ADAPTER = "createOpenAiExecutors";

// ─── createOpenAiExecutors ───

/**
 * Per-call OpenAI Chat Completions parameters a host can apply on top of what
 * the machine asked for — `reasoning_effort`, `service_tier`,
 * `max_completion_tokens`, and anything else the API accepts. Typed straight
 * off the installed `openai` package, so it tracks that version instead of
 * restating its vocabulary.
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

/** Raw result shape from {@link OpenAiExecutors.decide} — the chosen event plus the call metadata, delivered per decision attempt to `onResult`. */
export type OpenAiDecideResult = {
  event: ChosenEvent;
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
 * `openai` package's Chat Completions API. Compare `createAiSdkExecutors` —
 * same shape, different SDK underneath.
 *
 * Structured output uses `response_format: { type: 'json_schema' }` around the
 * `{ result, reasoning? }` provider output schema, and decisions force a tool call
 * with `tool_choice: 'required'`, one function tool per candidate event.
 *
 * @example
 * ```ts
 * const executors = createOpenAiExecutors({
 *   client: new OpenAI(),
 *   resolveModel: () => 'gpt-6-luna',
 * });
 * const result = await runAgent(machine, { executors, input });
 * ```
 */
export function createOpenAiExecutors(options: CreateOpenAiExecutorsOptions): OpenAiExecutors {
  const { client, resolveModel = (modelRef: string) => modelRef } = options;

  // Params every text call shares. Host `settings` sit UNDER the request's own
  // settings, which are `defined()`-filtered so an unset request field can
  // never erase a host one. `model`/`messages` are written first and are not
  // settable, so the cast only re-asserts what the spreads preserve.
  const textParams = (
    request: AgentTextRequest & { tools: AgentTools },
    messages: ChatCompletionMessageParam[],
    extra: Partial<ChatCompletionCreateParamsNonStreaming> = {},
  ): ChatCompletionCreateParamsNonStreaming => {
    const tools = toOpenAiTools(request.tools);
    return {
      model: resolveModel(request.model),
      messages,
      ...callSettings(options, request),
      ...toOpenAiCallSettings(request),
      ...(tools.length > 0 ? { tools } : {}),
      ...extra,
    } as ChatCompletionCreateParamsNonStreaming;
  };

  // The JSON Schema for the `{ result, reasoning? }` provider output, or `undefined`
  // when the request's schema doesn't expose the `~standard.jsonSchema`
  // extension — in which case the call falls back to plain text.
  const structuredSchema = async (request: AgentTextRequest) => {
    if (!isStructuredOutputSchema(request.outputSchema)) {
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

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiGenerateResult> => {
    const jsonSchema = await structuredSchema(request);
    const responseFormat: Partial<ChatCompletionCreateParamsNonStreaming> = jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "output",
              schema: jsonSchema,
              // Arbitrary JSON Schema (e.g. from Zod) may use features
              // outside OpenAI's strict-mode subset (defaults, unions, …) —
              // leaving strict mode off keeps this general rather than
              // requiring schema authors to hand-tune for OpenAI.
              strict: false,
            },
          },
        }
      : {};

    // The host-side tool loop. `maxSteps` bounds the number of OpenAI calls
    // (default 1, single-step, like the AI SDK adapter): each step that comes
    // back with tool calls runs them, appends the assistant `tool_calls`
    // message and one tool message per result, and asks again. The loop ends on
    // a step with no tool calls, on the step budget, or on a tool with no
    // `execute` — a client-side tool, whose call belongs to the caller, so the
    // result comes back with `finishReason: 'tool-calls'` and the raw response.
    const maxSteps = normalizeMaxSteps(request.maxSteps);
    const messages = toOpenAiMessages(request);
    const toolChoice = toOpenAiToolChoice(request.toolChoice);
    let response: ChatCompletion;
    let usage: AgentCallUsage | undefined;
    let step = 0;

    for (;;) {
      step++;
      response = (await client.chat.completions.create(
        textParams(request, messages, {
          ...responseFormat,
          // A forced choice applies to the FIRST step only: re-sending
          // `'required'` after a tool ran would force another call every step
          // and burn the budget without ever producing an answer.
          ...(step === 1 && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        }),
        { signal: info?.signal },
      )) as ChatCompletion;
      usage = addAgentCallUsage(usage, toAgentCallUsage(response.usage));

      const message = response.choices[0]?.message;
      const toolCalls = message?.tool_calls ?? [];
      if (toolCalls.length === 0 || step >= maxSteps) {
        break;
      }
      const executors = toolCalls.map((call) =>
        call.type === "function" ? toolExecutor(request.tools, call.function.name) : undefined,
      );
      if (executors.some((execute) => !execute)) {
        break;
      }

      messages.push(message as ChatCompletionMessageParam);
      for (const [index, call] of toolCalls.entries()) {
        const input: unknown =
          call.type === "function" && call.function.arguments
            ? JSON.parse(call.function.arguments)
            : {};
        let content: string;
        try {
          content = toToolContent(await executors[index]!(input));
        } catch (error) {
          // A thrown tool goes back to the model as an error result, the way
          // the AI SDK's loop reports one, rather than failing the request.
          content = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    // Validated parse of the `{ result, reasoning? }` provider output — no cast.
    const unwrap = (content: string | null | undefined) =>
      parseProviderOutput(request, content ? JSON.parse(content) : undefined);

    const choice = response.choices[0];
    const finishReason = fromSnakeCaseFinishReason(choice?.finish_reason);
    const content = choice?.message.content;

    if (jsonSchema) {
      // A structured request that ran out of tokens has no usable output: the
      // JSON object never closed, and even a closed one only closed because the
      // model stopped mid-thought. Either way, not a final answer for a
      // machine — `partialOutput` carries whatever text did arrive.
      if (finishReason === "length") {
        throw truncated(ADAPTER, request, info, content ?? undefined);
      }
      const parsed = unwrap(content);
      return {
        result: parsed.result,
        ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
        ...usageField(usage),
        finishReason,
        raw: response,
      };
    }

    // A text request that ran out of tokens still has its text. It comes back
    // with `finishReason: 'length'` — the machine decides what that is worth.
    return {
      result: content ?? "",
      ...usageField(usage),
      finishReason,
      raw: response,
    };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiStreamResult> => {
    // Text-only by design: no tools, no `response_format`. A request that
    // needs either is refused rather than silently downgraded to text.
    if (isStructuredOutputSchema(request.outputSchema)) {
      refuseStructuredStream(ADAPTER);
    }
    if (Object.keys(request.tools).length > 0) {
      throw new Error(
        "createOpenAiExecutors: streamText is text-only \u2014 a request declaring tools must be " +
          "routed to generateText.",
      );
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
        finishReason = fromSnakeCaseFinishReason(choice.finish_reason);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    return { result: text, ...usageField(toAgentCallUsage(usage)), finishReason, raw: last };
  };

  const decide = async (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiDecideResult> => {
    const response = (await client.chat.completions.create(
      {
        model: resolveModel(request.model),
        messages: toDecisionMessages(request),
        ...callSettings(options, request),
        ...toOpenAiCallSettings(request),
        tools: toOpenAiEventTools(request.events),
        tool_choice: "required",
      } as ChatCompletionCreateParamsNonStreaming,
      { signal: info?.signal },
    )) as ChatCompletion;

    const toolCall = response.choices[0]?.message.tool_calls?.[0];
    const call = toolCall?.type === "function" ? toolCall.function : undefined;
    const chosenEvent = eventForToolCall(ADAPTER, request.events, call?.name);
    const args: unknown = call?.arguments ? JSON.parse(call.arguments) : {};

    return {
      event: toChosenEvent(chosenEvent, args),
      ...usageField(toAgentCallUsage(response.usage)),
      finishReason: fromSnakeCaseFinishReason(response.choices[0]?.finish_reason),
      raw: response,
    };
  };

  return { generateText, streamText, decide };
}
