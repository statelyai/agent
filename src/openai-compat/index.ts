/**
 * OpenAI-compatible Chat Completions adapter — a COMPLETE `{ generateText,
 * streamText, decide }` executor set built on raw `fetch`, with zero runtime
 * dependencies (no `openai` package, no Vercel AI SDK).
 *
 * The OpenAI Chat Completions wire format is the lingua franca of hosted and
 * local inference: Groq, Together, Fireworks, OpenRouter, vLLM, Ollama, LM
 * Studio, and OpenAI itself all speak it. Point `baseUrl` at any of them.
 *
 * Compare `createAiSdkExecutors` in `../ai-sdk/index.ts` (the AI-SDK-backed
 * adapter) — same three-function contract, different transport. The request
 * mapping is ported from `examples/openai-sdk-host/index.ts`, but wired
 * against `POST {baseUrl}/chat/completions` instead of the `openai` package.
 */
import {
  buildEnvelopeSchema,
  getAgentOutputMode,
  type AgentRequestExecutor,
  type AgentRequestExecutors,
  type AgentTextRequest,
} from "../text-logic.js";
import { getJsonSchema } from "../utils.js";
import type { AgentDecisionExecutor } from "../decision.js";
import type { ChosenEvent } from "../types.js";
import {
  pruneUndefined,
  toDecisionMessages,
  toOpenAiCallSettings,
  toOpenAiEventTools,
  toOpenAiMessages,
  toOpenAiTools,
  type WireResponse,
} from "./mappers.js";

// ─── createOpenAiCompatExecutors ───

/** Minimal `fetch` shape the adapter needs — matches the global `fetch` and
 * Cloudflare Workers' `fetch`, so a custom transport is drop-in. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}>;

/** Options for {@link createOpenAiCompatExecutors}. */
export interface CreateOpenAiCompatExecutorsOptions {
  /** Base URL of the Chat Completions API, e.g. `"https://api.groq.com/openai/v1"`
   * or `"http://localhost:11434/v1"`. `/chat/completions` is appended. */
  baseUrl: string;
  /** Bearer token sent as `Authorization: Bearer <apiKey>`. Omit for keyless
   * local servers (Ollama, LM Studio). */
  apiKey?: string;
  /** Extra headers merged onto every request (e.g. `HTTP-Referer` for OpenRouter). */
  headers?: Record<string, string>;
  /** `fetch` override for Workers/tests. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Default wire model id, used when a request's model ref is empty. */
  model?: string;
  /** Model ref → wire model id map. A `request.model` present here resolves
   * to its mapped id; otherwise it passes through as the wire id. */
  models?: Record<string, string>;
}

/** `createOpenAiCompatExecutors` always populates all three executor slots. */
export interface OpenAiCompatExecutors extends AgentRequestExecutors {
  generateText: NonNullable<AgentRequestExecutors["generateText"]>;
  streamText: NonNullable<AgentRequestExecutors["streamText"]>;
  decide: AgentDecisionExecutor;
}

/**
 * Builds a complete `{ generateText, streamText, decide }` executor set over
 * the OpenAI Chat Completions wire format via raw `fetch`.
 *
 * @example
 * ```ts
 * const executors = createOpenAiCompatExecutors({
 *   baseUrl: 'https://api.groq.com/openai/v1',
 *   apiKey: process.env.GROQ_API_KEY,
 *   models: { quick: 'llama-3.3-70b-versatile' },
 * });
 * const result = await runAgent(machine, { input, executors });
 * ```
 */
export function createOpenAiCompatExecutors(
  options: CreateOpenAiCompatExecutorsOptions,
): OpenAiCompatExecutors {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (!doFetch) {
    throw new Error(
      "createOpenAiCompatExecutors: no `fetch` available — pass options.fetch for this runtime.",
    );
  }
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  function resolveModel(modelRef: string): string {
    const resolved = options.models?.[modelRef] ?? modelRef ?? options.model;
    if (!resolved) {
      throw new Error(
        "createOpenAiCompatExecutors: no model to send — set request.model, options.model, or options.models.",
      );
    }
    return resolved;
  }

  function buildHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      ...options.headers,
    };
  }

  async function post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const response = await doFetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const snippet = await response.text().catch(() => "");
      throw new Error(
        `createOpenAiCompatExecutors: ${url} responded ${response.status} ${response.statusText}: ` +
          snippet.slice(0, 500),
      );
    }
    return response;
  }

  const generateText: AgentRequestExecutor = async (request, info) => {
    const tools = toOpenAiTools(request.tools);
    const body: Record<string, unknown> = {
      model: resolveModel(request.model),
      messages: toOpenAiMessages(request),
      ...toOpenAiCallSettings(request),
      ...(tools.length > 0 ? { tools } : {}),
      ...(request.toolChoice ? { tool_choice: toWireToolChoice(request.toolChoice) } : {}),
    };

    const structured = getAgentOutputMode(request.outputSchema) === "structured";
    // Every structured request is sent as the uniform `{ result, reasoning? }`
    // envelope — a root object is universally accepted, unlike a bare union/
    // array root. Unwrap `.result` below before the machine validates the
    // declared schema.
    if (structured) {
      const envelope = buildEnvelopeSchema(request.outputSchema!, {
        reasoning: request.reasoning,
      });
      const jsonSchema = await getJsonSchema(envelope);
      body.response_format = jsonSchema
        ? {
            type: "json_schema",
            json_schema: {
              name: "output",
              schema: jsonSchema,
              // Arbitrary JSON Schema (e.g. from Zod) may use features outside
              // OpenAI's strict-mode subset — leaving strict off keeps this
              // general across backends rather than OpenAI-tuned.
              strict: false,
            },
          }
        : // Schema can't lower to JSON Schema: fall back to json_object mode
          // and parse the returned text ourselves.
          { type: "json_object" };
    }

    const response = await post(body, info?.signal);
    const json = (await response.json()) as WireResponse;
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? "";

    if (structured) {
      let parsed: unknown;
      try {
        parsed = content ? JSON.parse(content) : undefined;
      } catch (error) {
        throw new Error(
          `createOpenAiCompatExecutors: generateText${nameSuffix(request)} — structured request ` +
            `returned non-JSON content: ${errorMessage(error)}`,
        );
      }
      // Unwrap the `{ result, reasoning? }` envelope so the machine validates
      // the declared schema; surface `reasoning` on the raw result only.
      let output = parsed;
      let reasoning: string | undefined;
      if (parsed && typeof parsed === "object" && "result" in parsed) {
        output = (parsed as { result: unknown }).result;
        const rawReasoning = (parsed as { reasoning?: unknown }).reasoning;
        if (typeof rawReasoning === "string") {
          reasoning = rawReasoning;
        }
      }
      return {
        output,
        ...(reasoning !== undefined ? { reasoning } : {}),
        usage: json.usage,
        finishReason: choice?.finish_reason ?? undefined,
      };
    }

    return { output: content, usage: json.usage, finishReason: choice?.finish_reason ?? undefined };
  };

  const streamText: AgentRequestExecutor = async (request, info) => {
    const body: Record<string, unknown> = {
      model: resolveModel(request.model),
      messages: toOpenAiMessages(request),
      ...toOpenAiCallSettings(request),
      stream: true,
    };

    const response = await post(body, info?.signal);
    let text = "";
    for await (const data of iterateSse(response, request)) {
      let chunk: WireResponse;
      try {
        chunk = JSON.parse(data) as WireResponse;
      } catch (error) {
        throw new Error(
          `createOpenAiCompatExecutors: streamText${nameSuffix(request)} — malformed SSE JSON ` +
            `chunk: ${errorMessage(error)}`,
        );
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        info?.onChunk?.(delta);
      }
    }
    return { output: text };
  };

  const decide: AgentDecisionExecutor = async (request) => {
    const tools = toOpenAiEventTools(request.events);
    const body: Record<string, unknown> = {
      model: resolveModel(request.model),
      messages: toDecisionMessages(request),
      tools,
      tool_choice: "required",
      ...pruneUndefined({
        temperature: request.temperature,
        max_tokens: request.maxOutputTokens,
        top_p: request.topP,
        seed: request.seed,
        stop: request.stopSequences,
      }),
    };

    const response = await post(body, request.signal);
    const json = (await response.json()) as WireResponse;
    const choice = json.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall || (toolCall.type && toolCall.type !== "function") || !toolCall.function?.name) {
      throw new Error("createOpenAiCompatExecutors: decide — model did not call an event tool.");
    }
    const chosenEvent = request.events.find((event) => event.toolName === toolCall.function!.name);
    if (!chosenEvent) {
      throw new Error(
        `createOpenAiCompatExecutors: decide — model called unknown tool '${toolCall.function.name}'.`,
      );
    }

    let args: unknown = {};
    if (toolCall.function.arguments) {
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (error) {
        throw new Error(
          `createOpenAiCompatExecutors: decide — could not parse tool arguments for ` +
            `'${chosenEvent.type}': ${errorMessage(error)}`,
        );
      }
    }

    return {
      // The event's own `type` is spread LAST so it always wins: a stray
      // `type` key in the model's parsed tool arguments can never override the
      // machine event type. Event payloads are flat under the event object, so
      // a payload field named `type` is unrepresentable by construction.
      event: {
        ...(args && typeof args === "object" ? args : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
      usage: json.usage,
      finishReason: choice?.finish_reason ?? undefined,
    };
  };

  return { generateText, streamText, decide };
}

/** Maps an `AgentToolChoice` to the wire `tool_choice` shape. */
function toWireToolChoice(toolChoice: AgentTextRequest["toolChoice"]): unknown {
  return typeof toolChoice === "object"
    ? { type: "function", function: { name: toolChoice.name } }
    : toolChoice;
}

// Reads an SSE (`text/event-stream`) response line by line, yielding each
// `data:` payload string and stopping at `[DONE]`.
async function* iterateSse(
  response: Awaited<ReturnType<FetchLike>>,
  request: AgentTextRequest,
): AsyncGenerator<string> {
  const body = response.body;
  if (!body) {
    throw new Error(
      `createOpenAiCompatExecutors: streamText${nameSuffix(request)} — response has no body to ` +
        `read SSE from.`,
    );
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushLine = function* (line: string): Generator<string> {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) {
      return;
    }
    const data = trimmed.slice("data:".length).trim();
    if (data && data !== "[DONE]") {
      yield data;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield* flushLine(line);
    }
  }
  yield* flushLine(buffer);
}

function nameSuffix(request: { name?: string }): string {
  return request.name ? ` '${request.name}'` : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
