/**
 * The raw `openai` package adapter: builds the `{ generateText, streamText,
 * decide }` executor set consumed by `runAgent`/`executeAgentRequest`, mapped
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
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  // `ChatCompletionTool` spans the whole supported `openai` peer range; the
  // narrower `ChatCompletionFunctionTool` name only exists in later releases.
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";
import {
  AGENT_USAGE_TOKEN_FIELDS,
  buildEnvelopeSchema,
  getAgentOutputMode,
  parseStructuredEnvelope,
  type AgentCallUsage,
  type AgentFinishReason,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
} from "../text-logic.js";
import { AgentTruncatedError } from "../errors.js";
import { renderDecisionAttempts, type AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type {
  AgentMessage,
  AgentTool,
  AgentToolChoice,
  AgentTools,
  ChosenEvent,
  DataContent,
  ToolResultPart,
} from "../types.js";
import { getJsonSchema, getJsonSchemaSync, isStandardSchema } from "../utils.js";

// ─── Request → OpenAI param mapping (pure, unit-testable) ───

/** Thrown for a message part Chat Completions cannot carry — dropping it would
 * silently change what the model sees. */
function unsupportedPart(role: string, type: string): never {
  throw new Error(
    `createOpenAiExecutors: a ${role} message part of type '${type}' has no Chat Completions ` +
      "equivalent. Send text, image, tool-call, or tool-result parts, or convert it before the " +
      "request.",
  );
}

/** A `DataContent`/`URL` image as the URL string OpenAI's `image_url` part wants:
 * an http(s) or `data:` string and a `URL` pass through, a bare base64 string and
 * raw bytes are wrapped in a data URL. */
function toImageUrl(image: DataContent | URL, mediaType: string | undefined): string {
  if (image instanceof URL) {
    return image.href;
  }
  const type = mediaType ?? "image/jpeg";
  if (typeof image === "string") {
    return /^(https?:|data:)/.test(image) ? image : `data:${type};base64,${image}`;
  }
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  const encode = (globalThis as { btoa?: (data: string) => string }).btoa;
  if (!encode) {
    throw new Error(
      "createOpenAiExecutors: binary image parts need a global `btoa` to base64-encode. Pass the " +
        "image as a URL or a base64 string instead.",
    );
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:${type};base64,${encode(binary)}`;
}

/** One OpenAI tool message per `ToolResultPart` — the tool role is one message per result. */
function toToolMessage(part: ToolResultPart): ChatCompletionMessageParam {
  return {
    role: "tool",
    content:
      part.output.type === "text" || part.output.type === "error-text"
        ? part.output.value
        : JSON.stringify(part.output.value),
    tool_call_id: part.toolCallId,
  };
}

/** Maps `AgentTextRequest.messages`/`system`/`prompt` to OpenAI chat messages. */
export function toOpenAiMessages(
  request: Pick<AgentTextRequest, "system" | "prompt"> & { messages?: AgentMessage[] },
): ChatCompletionMessageParam[] {
  if (request.messages) {
    // AgentMessage's `system|user|assistant|tool` roles map 1:1 onto OpenAI's
    // message roles; string content is directly compatible with OpenAI's
    // content union for each role. Multi-part content is mapped part by part,
    // and a part Chat Completions cannot carry throws rather than vanishing.
    return request.messages.flatMap((message): ChatCompletionMessageParam[] => {
      switch (message.role) {
        case "system":
          return [{ role: "system", content: message.content }];
        case "user": {
          if (typeof message.content === "string") {
            return [{ role: "user", content: message.content }];
          }
          const content = message.content.map((part): ChatCompletionContentPart => {
            switch (part.type) {
              case "text":
                return { type: "text", text: part.text };
              case "image":
                return {
                  type: "image_url",
                  image_url: { url: toImageUrl(part.image, part.mediaType) },
                };
              default:
                return unsupportedPart("user", part.type);
            }
          });
          return [{ role: "user", content }];
        }
        case "assistant": {
          if (typeof message.content === "string") {
            return [{ role: "assistant", content: message.content }];
          }
          let text = "";
          const toolCalls: NonNullable<ChatCompletionAssistantMessageParam["tool_calls"]> = [];
          // A tool result carried inline on an assistant message becomes a
          // separate tool message after it — where Chat Completions puts one.
          const trailing: ChatCompletionMessageParam[] = [];
          for (const part of message.content) {
            switch (part.type) {
              case "text":
                text += part.text;
                break;
              case "tool-call":
                toolCalls.push({
                  id: part.toolCallId,
                  type: "function",
                  function: {
                    name: part.toolName,
                    arguments: JSON.stringify(part.input ?? {}),
                  },
                });
                break;
              case "tool-result":
                trailing.push(toToolMessage(part));
                break;
              default:
                unsupportedPart("assistant", part.type);
            }
          }
          return [
            {
              role: "assistant",
              content: text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            ...trailing,
          ];
        }
        case "tool":
          return message.content.map(toToolMessage);
      }
    });
  }

  const messages: ChatCompletionMessageParam[] = [];
  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push({ role: "user", content: request.prompt ?? "" });
  return messages;
}

/** Drops keys whose value is `undefined`, so a spread cannot erase what it lands on. */
function defined<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Maps the generation settings a text and a decision request share onto OpenAI
 * Chat Completions parameters, with unset keys omitted.
 *
 * Omitting matters: these are the top layer of a stack — the host's
 * {@link CreateOpenAiExecutorsOptions.settings}, then the request's — and an
 * `undefined` spread over the layer below would erase it.
 *
 * `max_tokens` is deprecated by OpenAI in favor of `max_completion_tokens`, so
 * that's what `maxOutputTokens` targets. Chat Completions has no `top_k`
 * parameter, so `topK` is dropped.
 */
export function toOpenAiCallSettings(
  request: Pick<
    AgentTextRequest,
    "temperature" | "maxOutputTokens" | "topP" | "seed" | "stopSequences"
  >,
) {
  return defined({
    temperature: request.temperature,
    max_completion_tokens: request.maxOutputTokens,
    top_p: request.topP,
    seed: request.seed,
    stop: request.stopSequences,
  });
}

/** A tool `description` may be a string or, for an AI SDK v7 tool, a function
 * of the call's context. A raw JSON payload can only carry the static form. */
function staticDescription(descriptor: AgentTool): string | undefined {
  if (typeof descriptor === "function") {
    return undefined;
  }
  return typeof descriptor.description === "string" ? descriptor.description : undefined;
}

/** One OpenAI function tool per `AgentTools` entry. */
export function toOpenAiTools(tools: AgentTools): ChatCompletionTool[] {
  return Object.entries(tools).flatMap(([name, descriptor]) => {
    if (!descriptor) {
      return [];
    }
    const inputSchema = typeof descriptor === "function" ? undefined : descriptor.inputSchema;
    return [
      {
        type: "function" as const,
        function: {
          name,
          description: staticDescription(descriptor),
          parameters:
            (isStandardSchema(inputSchema) ? getJsonSchemaSync(inputSchema) : undefined) ?? {},
        },
      },
    ];
  });
}

/**
 * Maps an {@link AgentToolChoice} onto OpenAI's `tool_choice` —
 * `{ type: 'tool', name }` becomes `{ type: 'function', function: { name } }`;
 * `'auto'`/`'none'`/`'required'` are OpenAI's own vocabulary and pass through.
 * `undefined` stays `undefined`, so the key is omitted.
 */
export function toOpenAiToolChoice(toolChoice: AgentToolChoice | undefined) {
  if (toolChoice === undefined) {
    return undefined;
  }
  return typeof toolChoice === "object"
    ? { type: "function" as const, function: { name: toolChoice.name } }
    : toolChoice;
}

/** One OpenAI function tool per candidate decision event — the "tool-per-event
 * + tool_choice: 'required'" recipe, mirroring `toAiSdkEventTools`. */
export function toOpenAiEventTools(events: AgentEventDescriptor[]): ChatCompletionTool[] {
  return events.map((event) => ({
    type: "function" as const,
    function: {
      name: event.toolName,
      description: `Choose the '${event.type}' move.`,
      parameters: getJsonSchemaSync(event.inputSchema) ?? {},
    },
  }));
}

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

/**
 * Maps an OpenAI `finish_reason` onto the portable {@link AgentFinishReason}.
 * `'function_call'` (the deprecated legacy path) joins `'tool_calls'` under
 * `'tool-calls'`; anything unrecognized, including a missing reason, lands on
 * `'other'`. OpenAI's own string stays on the result's `raw`.
 */
export function toAgentFinishReason(
  finishReason: ChatCompletion.Choice["finish_reason"] | null | undefined,
): AgentFinishReason {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "other";
  }
}

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
 * Raw result shape from {@link OpenAiExecutors.generateText} — the `{ output }`
 * envelope (the validated structured object for structured-output requests, or
 * the model's text otherwise) plus the call metadata. Core only reads `output`; everything else flows
 * verbatim to `runAgent`'s `onResult(request, { raw })`.
 */
export type OpenAiGenerateResult = {
  output: unknown;
  /** The model's reasoning, present only when the request opted in via
   * `includeReasoning` and the model produced it. Never enters machine
   * context/output. */
  reasoning?: string;
  /** The call's token usage, on the flat field names `runAgent` folds into the
   * run result's aggregated `AgentUsage`. Absent when OpenAI reported none. */
  usage?: AgentCallUsage;
  /** Why the call stopped, normalized to the portable {@link AgentFinishReason}. OpenAI's own value stays on `raw`. */
  finishReason: AgentFinishReason;
  /** The untouched OpenAI response. */
  raw: unknown;
};

/** Raw result shape from {@link OpenAiExecutors.streamText} — the accumulated text once the stream finishes (chunks are delivered separately via `onChunk`), plus the stream's final usage/finish metadata. */
export type OpenAiStreamResult = {
  output: string;
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
export function addAgentCallUsage(
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
 * `openai` package's Chat Completions API. Compare `createAiSdkExecutors` —
 * same shape, different SDK underneath.
 *
 * Structured output uses `response_format: { type: 'json_schema' }` around the
 * uniform `{ result, reasoning? }` envelope, and decisions force a tool call
 * with `tool_choice: 'required'`, one function tool per candidate event.
 *
 * @example
 * ```ts
 * const executors = createOpenAiExecutors({
 *   client: new OpenAI(),
 *   resolveModel: () => 'gpt-5.4-mini',
 * });
 * const result = await runAgent(machine, { input, executors });
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

  // The JSON Schema for the `{ result, reasoning? }` envelope, or `undefined`
  // when the request's schema doesn't expose the `~standard.jsonSchema`
  // extension — in which case the call falls back to plain text.
  const envelopeSchema = async (request: AgentTextRequest) => {
    if (getAgentOutputMode(request.outputSchema) !== "structured") {
      return undefined;
    }
    // THE structured-output envelope contract (see docs/hosts.md): send the
    // declared schema wrapped as `{ result, reasoning? }` — a root object is
    // universally accepted — then unwrap `.result` before returning, so the
    // machine validates the bare schema it declared.
    return getJsonSchema(
      buildEnvelopeSchema(request.outputSchema!, { reasoning: request.includeReasoning }),
    );
  };

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiGenerateResult> => {
    const jsonSchema = await envelopeSchema(request);
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
    // A non-finite `maxSteps` (NaN, Infinity) would never satisfy the bound
    // check below and let a model that keeps calling tools run unbounded, so
    // it falls back to the single-call default like an absent value.
    const maxSteps =
      typeof request.maxSteps === "number" && Number.isFinite(request.maxSteps)
        ? Math.max(1, Math.floor(request.maxSteps))
        : 1;
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

    // Validated unwrap of the `{ result, reasoning? }` envelope — no cast.
    const unwrap = (content: string | null | undefined) =>
      parseStructuredEnvelope(request, content ? JSON.parse(content) : undefined);

    const choice = response.choices[0];
    const finishReason = toAgentFinishReason(choice?.finish_reason);
    const content = choice?.message.content;

    if (jsonSchema) {
      // A structured request that ran out of tokens has no usable output: the
      // envelope never closed, and even a closed one only closed because the
      // model stopped mid-thought. Either way, not a final answer for a
      // machine — `partialOutput` carries whatever text did arrive.
      if (finishReason === "length") {
        throw truncated(request, info, content ?? undefined);
      }
      const parsed = unwrap(content);
      return {
        output: parsed.result,
        ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
        ...usageField(usage),
        finishReason,
        raw: response,
      };
    }

    // A text request that ran out of tokens still has its text. It comes back
    // with `finishReason: 'length'` — the machine decides what that is worth.
    return {
      output: content ?? "",
      ...usageField(usage),
      finishReason,
      raw: response,
    };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiStreamResult> => {
    // Text-only by design: no tools, no `response_format`. A chunk-by-chunk
    // structured envelope has nothing useful to hand `onChunk` mid-stream, so
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

    return { output: text, ...usageField(toAgentCallUsage(usage)), finishReason, raw: last };
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
    if (!toolCall || toolCall.type !== "function") {
      throw new Error("createOpenAiExecutors: decide — model did not call an event tool.");
    }
    const chosenEvent = request.events.find((event) => event.toolName === toolCall.function.name);
    if (!chosenEvent) {
      throw new Error(
        `createOpenAiExecutors: decide — model called unknown tool '${toolCall.function.name}'.`,
      );
    }

    const args: unknown = toolCall.function.arguments
      ? JSON.parse(toolCall.function.arguments)
      : {};

    return {
      // The event's own `type` is spread LAST so it always wins: a stray
      // `type` key in the model's tool input can never override the machine
      // event type.
      event: {
        ...(args && typeof args === "object" ? args : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
      ...usageField(toAgentCallUsage(response.usage)),
      finishReason: toAgentFinishReason(response.choices[0]?.finish_reason),
      raw: response,
    };
  };

  return { generateText, streamText, decide };
}
