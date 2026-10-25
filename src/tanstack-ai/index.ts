/**
 * The TanStack AI adapter: builds the `{ generateText, streamText, decide }`
 * executor set consumed by `createAgentRuntime`/`executeAgentRequest`, mapped
 * onto TanStack AI's `chat()` activity and any text adapter
 * (`openaiText(...)`, `anthropicText(...)`, `geminiText(...)`, …).
 *
 * `@tanstack/ai` is an OPTIONAL peer dependency, imported only here. No
 * provider package (`@tanstack/ai-openai`, …) is a dependency: the host passes
 * its own text adapters. Compare `@statelyai/agent/ai-sdk`, the same contract
 * over the Vercel AI SDK.
 */
import {
  chat,
  maxIterations,
  type AnyTextAdapter,
  type ChatMiddleware,
  type StreamChunk,
} from "@tanstack/ai";
import type { TextActivityOptions } from "@tanstack/ai/adapters";
import type { AnyStateMachine } from "xstate";
import {
  resolveHostSettings,
  resolveModelEntry,
  resolveModelSource,
} from "../internal/model-source.js";
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
import type {
  AgentMessage,
  AssistantMessage,
  AgentToolChoice,
  AgentTools,
  ChosenEvent,
  ToolCallPart,
  ToolResultOutput,
  ToolResultPart,
} from "../types.js";
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
  toTanStackAiEventTools,
  toTanStackAiMessages,
  toTanStackAiModelOptions,
  toTanStackAiTools,
  type GenerationSettings,
} from "./mappers.js";

const ADAPTER = "createTanStackAiExecutors";

/** A model's tool call, as read off the run's `TOOL_CALL_*` events. */
export type TanStackAiToolCall = { toolCallId: string; toolName: string; input: unknown };

/** What one `chat()` run produced, folded from its chunks. */
type RunSummary = {
  text: string;
  structured: unknown;
  usage: AgentCallUsage | undefined;
  finishReason: AgentFinishReason;
  toolCalls: TanStackAiToolCall[];
  messages: AgentMessage[];
  chunks: StreamChunk[];
};

// A tool result's content as the run carried it: JSON when it parses, text
// otherwise. Multimodal content parts are kept as JSON.
function toToolResultOutput(content: unknown): ToolResultOutput {
  if (typeof content !== "string") {
    return { type: "json", value: content };
  }
  try {
    return { type: "json", value: JSON.parse(content) };
  } catch {
    return { type: "text", value: content };
  }
}

/** A `RUN_ERROR` chunk as the `Error` it reports, `code` included. */
class TanStackAiRunError extends Error {
  code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "TanStackAiRunError";
    this.code = code;
  }
}

/**
 * Reads a `chat()` stream to the end. Text arrives as `TEXT_MESSAGE_CONTENT`
 * deltas; every model turn ends in its own `RUN_FINISHED`, so a tool loop's
 * usage is summed and the last finish reason wins. A provider failure arrives
 * as a `RUN_ERROR` chunk rather than a throw, and is thrown here.
 */
async function readRun(
  stream: AsyncIterable<StreamChunk>,
  onDelta?: (delta: string) => void,
): Promise<RunSummary> {
  const summary: RunSummary = {
    text: "",
    structured: undefined,
    usage: undefined,
    finishReason: "other",
    toolCalls: [],
    messages: [],
    chunks: [],
  };
  const args = new Map<string, { part: ToolCallPart; json: string }>();

  // The response messages, in the order a later request replays them: each
  // model turn's assistant message (text and tool calls), then one tool
  // message with the results `chat()` fed back before the next turn.
  let assistant: Extract<AssistantMessage["content"], unknown[]> | undefined;
  let results: ToolResultPart[] | undefined;
  const flushAssistant = () => {
    if (assistant?.length) summary.messages.push({ role: "assistant", content: assistant });
    assistant = undefined;
  };
  const flushResults = () => {
    if (results?.length) summary.messages.push({ role: "tool", content: results });
    results = undefined;
  };
  const assistantParts = () => {
    flushResults();
    return (assistant ??= []);
  };

  for await (const chunk of stream) {
    summary.chunks.push(chunk);
    switch (chunk.type) {
      case "TEXT_MESSAGE_CONTENT": {
        summary.text += chunk.delta;
        onDelta?.(chunk.delta);
        const parts = assistantParts();
        const last = parts.at(-1);
        if (last?.type === "text") last.text += chunk.delta;
        else parts.push({ type: "text", text: chunk.delta });
        break;
      }
      case "TOOL_CALL_START": {
        const part: ToolCallPart = {
          type: "tool-call",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolCallName,
          input: {},
        };
        assistantParts().push(part);
        args.set(chunk.toolCallId, { part, json: "" });
        break;
      }
      case "TOOL_CALL_ARGS": {
        const call = args.get(chunk.toolCallId);
        if (call) call.json += chunk.delta;
        break;
      }
      case "TOOL_CALL_RESULT": {
        flushAssistant();
        (results ??= []).push({
          type: "tool-result",
          toolCallId: chunk.toolCallId,
          toolName: args.get(chunk.toolCallId)?.part.toolName ?? "",
          output: toToolResultOutput(chunk.content),
        });
        break;
      }
      case "CUSTOM":
        if (chunk.name === "structured-output.complete") {
          summary.structured = (chunk.value as { object?: unknown } | undefined)?.object;
        }
        break;
      case "RUN_FINISHED": {
        // In process, the finish reason rides on `metadata.tanstack`.
        const finishReason =
          chunk.finishReason ??
          (chunk.metadata?.tanstack as { finishReason?: string | null } | undefined)?.finishReason;
        summary.finishReason = fromSnakeCaseFinishReason(finishReason);
        if (chunk.usage && !Array.isArray(chunk.usage)) {
          summary.usage = addAgentCallUsage(summary.usage, toAgentCallUsage(chunk.usage));
        }
        break;
      }
      case "RUN_ERROR":
        throw new TanStackAiRunError(chunk.message, chunk.code ?? chunk.error?.code);
    }
  }
  for (const { part, json } of args.values()) {
    part.input = json ? JSON.parse(json) : {};
  }
  flushAssistant();
  flushResults();
  summary.toolCalls = [...args.values()].map(({ part }) => ({
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
  }));
  return summary;
}

// ─── createTanStackAiExecutors ───

/**
 * Per-call `chat()` options a host can apply on top of what the machine asked
 * for — provider `modelOptions` (reasoning effort, …), `middleware`,
 * `metadata`, `debug`, and anything else `chat()` accepts. Typed off the
 * installed `@tanstack/ai`, so it tracks that version.
 *
 * The request's own fields are excluded: messages, system prompts, tools,
 * output schema, streaming, cancellation, and the tool-loop bound belong to the
 * machine and the adapter.
 */
export type TanStackAiCallSettings = Omit<
  TextActivityOptions<AnyTextAdapter, undefined, boolean>,
  | "adapter"
  | "messages"
  | "systemPrompts"
  | "tools"
  | "outputSchema"
  | "stream"
  | "abortController"
  | "agentLoopStrategy"
>;

/**
 * One entry in a {@link TanStackAiModelMap}: a bare text adapter, or an adapter
 * paired with the {@link TanStackAiCallSettings} that ref always runs with — how
 * a host gives a ref a persona without the machine naming a provider knob.
 */
export type TanStackAiModelEntry =
  | AnyTextAdapter
  | { adapter: AnyTextAdapter; settings?: TanStackAiCallSettings };

/** Model registry: maps model refs (as used in `setupAgent({ models })`) to
 * TanStack AI text adapters, or to `{ adapter, settings }` pairs. */
export type TanStackAiModelMap<TKey extends string = string> = Record<TKey, TanStackAiModelEntry>;

/**
 * Options for {@link createTanStackAiExecutors}: a static `models` map, a
 * `resolveModel` function (refs resolved dynamically), or both —
 * `resolveModel` takes precedence when both are supplied.
 *
 * `settings` carries `chat()` options that are the HOST's business, such as
 * provider `modelOptions`. Pass an object to apply it to every call, or a
 * function to vary it per request (`request.name` is the request's registered
 * key). Precedence is global `settings`, then the model entry's `settings`,
 * then the request's own generation settings (mapped onto the provider's
 * `modelOptions` for the `openai`, `anthropic`, and `gemini` adapters);
 * `modelOptions` merge key by key.
 */
export type CreateTanStackAiExecutorsOptions<
  TModels extends TanStackAiModelMap = TanStackAiModelMap,
> = {
  settings?:
    | TanStackAiCallSettings
    | ((request: AgentTextRequest | AgentDecisionRequest) => TanStackAiCallSettings | undefined);
} & (
  | {
      models: TModels;
      resolveModel?: (modelRef: keyof TModels & string) => AnyTextAdapter;
    }
  | {
      models?: TModels;
      resolveModel: (modelRef: string) => AnyTextAdapter;
    }
);

/**
 * Raw result shape from {@link TanStackAiExecutors.generateText} — `result`
 * (the parsed structured object for structured-output requests, or the text
 * otherwise) plus the run metadata. Core reads `result` and `usage`; everything
 * else flows verbatim to `onResult(request, { raw })`.
 */
export type TanStackAiGenerateResult = {
  result: unknown;
  /** The model's reasoning, present only when the request opted in via
   * `includeReasoning` and the model produced it. */
  reasoning?: string;
  /** Token usage summed over every model turn of the run. */
  usage?: AgentCallUsage;
  /** Why the run stopped, normalized to the portable {@link AgentFinishReason}. */
  finishReason: AgentFinishReason;
  /** Every tool call the model made during the run. */
  toolCalls: TanStackAiToolCall[];
  /** The run's response messages — each turn's assistant text and tool
   * calls, and the tool results fed back — ready to append to a
   * conversation. */
  messages: AgentMessage[];
  /** Every chunk the run produced, in order. */
  raw: StreamChunk[];
};

/** Raw result shape from {@link TanStackAiExecutors.streamText} — the
 * accumulated text once the stream finishes (deltas are delivered via
 * `onChunk`), plus the run's usage and finish reason. */
export type TanStackAiStreamResult = {
  result: string;
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  /** The run's response messages, as on {@link TanStackAiGenerateResult}. */
  messages: AgentMessage[];
  raw: StreamChunk[];
};

/** Raw result shape from {@link TanStackAiExecutors.decide} — the chosen event
 * plus the call metadata, delivered per decision attempt to `onResult`. */
export type TanStackAiDecideResult = {
  event: ChosenEvent;
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  raw: StreamChunk[];
};

/** `createTanStackAiExecutors` always populates all three slots, and its
 * results are concretely typed. */
export interface TanStackAiExecutors {
  generateText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<TanStackAiGenerateResult>;
  streamText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<TanStackAiStreamResult>;
  decide: (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ) => Promise<TanStackAiDecideResult>;
}

// A `{ adapter, settings }` pair, as opposed to a bare text adapter — which
// carries `kind: 'text'` and no `adapter` property of its own.
function isAdapterWithSettings(
  entry: TanStackAiModelEntry,
): entry is { adapter: AnyTextAdapter; settings?: TanStackAiCallSettings } {
  return "adapter" in entry && !("kind" in entry);
}

// TanStack AI reports a structured run cut off by the token limit as an error
// rather than a finish reason: `max_tokens` from the engine, or OpenAI's
// Responses `incomplete`, whose message is `max_output_tokens`.
function isTruncationError(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === "max_tokens" || code === "incomplete" || message === "max_output_tokens";
}

/**
 * Runs one `chat()` call to the end. `chat()` takes an `AbortController`, not
 * a signal, so the runtime's signal is bridged to one — and unhooked once the
 * run settles, so a long-lived signal does not collect a listener per request.
 * An aborted `chat()` stream just ends, so the abort is surfaced as the throw
 * it is.
 */
async function runChat(
  options: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onDelta?: (delta: string) => void,
): Promise<RunSummary> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  let run: RunSummary;
  try {
    run = await readRun(
      chat({ ...options, abortController: controller } as Parameters<
        typeof chat
      >[0]) as AsyncIterable<StreamChunk>,
      onDelta,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("createTanStackAiExecutors: the request was aborted.");
  }
  return run;
}

/**
 * A request's tool choice belongs to its first model turn. `chat()` reuses
 * `modelOptions` for every turn of its tool loop, so a forced choice left in
 * place would force another tool call after each result, and the request could
 * never answer. From the second turn on, the choice's keys go back to what the
 * host set, or away.
 */
function toolChoiceOnFirstTurn(keys: string[], later: Record<string, unknown>): ChatMiddleware {
  return {
    name: "statelyai:tool-choice-first-turn",
    onConfig: (ctx, config) => {
      if (ctx.iteration === 0) {
        return;
      }
      const modelOptions = { ...config.modelOptions };
      for (const key of keys) {
        if (key in later) modelOptions[key] = later[key];
        else delete modelOptions[key];
      }
      return { modelOptions };
    },
  };
}

/**
 * Builds the `{ generateText, streamText, decide }` executor set over TanStack
 * AI's `chat()`. Compare `createAiSdkExecutors` — same shape, different SDK
 * underneath.
 *
 * - Structured output uses `chat({ outputSchema })` around the
 *   `{ result, reasoning? }` provider output schema.
 * - Tools run in `chat()`'s own loop, for `generateText` and `streamText`
 *   alike, bounded by the request's `maxSteps` (default 1). A tool with no
 *   `execute` stops the run at its call.
 * - Decisions offer one tool per candidate event, with no `execute`, so the
 *   run stops at the model's first call; the tool choice is forced where the
 *   provider supports it (the `openai`, `anthropic`, and `gemini` adapters).
 *
 * Pass the options object, or pass the machine (or its `setupAgent(...)`
 * result) to reuse the `models` declared in `setupAgent({ models })`. Anything
 * else throws here, at construction.
 *
 * @example
 * ```ts
 * import { openaiText } from '@tanstack/ai-openai';
 *
 * const executors = createTanStackAiExecutors({ models: { quick: openaiText('gpt-6-luna') } });
 * const result = await runAgent(machine, { executors, input });
 * ```
 */
export function createTanStackAiExecutors<TModels extends TanStackAiModelMap>(
  options: CreateTanStackAiExecutorsOptions<TModels>,
): TanStackAiExecutors;
export function createTanStackAiExecutors(machine: AnyStateMachine): TanStackAiExecutors;
export function createTanStackAiExecutors<TModels extends TanStackAiModelMap>(
  source: CreateTanStackAiExecutorsOptions<TModels> | AnyStateMachine,
): TanStackAiExecutors {
  const options = resolveModelSource<CreateTanStackAiExecutorsOptions<TModels>>(ADAPTER, source);
  // Resolves a request's `model` ref to a text adapter plus the settings that
  // apply to it, merged in precedence order.
  const resolve = (
    request: AgentTextRequest | AgentDecisionRequest,
    portable: GenerationSettings & { toolChoice?: AgentToolChoice },
  ): { adapter: AnyTextAdapter; settings: TanStackAiCallSettings } => {
    const entry = resolveModelEntry<TanStackAiModelEntry>(ADAPTER, options, request.model);
    const { adapter, settings: entrySettings } = isAdapterWithSettings(entry)
      ? entry
      : { adapter: entry, settings: undefined };
    const host = resolveHostSettings(options.settings, request);
    const merged = { ...host, ...entrySettings };
    const base = { ...host.modelOptions, ...entrySettings?.modelOptions };
    const generation = toTanStackAiModelOptions(adapter, { ...portable, toolChoice: undefined });
    const firstTurn = toTanStackAiModelOptions(adapter, portable);
    const choiceKeys = Object.keys(firstTurn).filter((key) => !(key in generation));
    return {
      adapter,
      settings: {
        ...merged,
        modelOptions: { ...base, ...firstTurn },
        ...(choiceKeys.length > 0
          ? {
              middleware: [
                ...(merged.middleware ?? []),
                toolChoiceOnFirstTurn(choiceKeys, { ...base, ...generation }),
              ],
            }
          : {}),
      },
    };
  };

  // `maxSteps` bounds the model turns of `chat()`'s tool loop; the default is
  // one, like the AI SDK adapter.
  const loopBound = (request: AgentTextRequest) =>
    maxIterations(normalizeMaxSteps(request.maxSteps));

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<TanStackAiGenerateResult> => {
    const { adapter, settings } = resolve(request, request);
    const tools = toTanStackAiTools(request.tools);
    const structured = isStructuredOutputSchema(request.outputSchema);
    // The structured-output contract (see docs/hosts.md): send the declared
    // schema wrapped as `{ result, reasoning? }`, and return the parsed
    // `result`, which the machine validates against the schema it declared.
    const outputSchema = structured
      ? await getJsonSchema(
          providerOutputSchema(request.outputSchema!, { reasoning: request.includeReasoning }),
        )
      : undefined;

    let run: RunSummary;
    try {
      run = await runChat(
        {
          ...settings,
          adapter,
          ...toTanStackAiMessages(request),
          ...(tools.length > 0 ? { tools } : {}),
          ...(outputSchema ? { outputSchema, stream: true } : {}),
          agentLoopStrategy: loopBound(request),
        },
        info?.signal,
      );
    } catch (error) {
      throw structured && isTruncationError(error)
        ? truncated(ADAPTER, request, info, undefined, error)
        : error;
    }

    if (outputSchema) {
      // A structured output the model DID close, but only because it stopped
      // mid-thought, is not something to hand a machine as a final answer.
      if (run.finishReason === "length") {
        throw truncated(ADAPTER, request, info, run.structured ?? run.text);
      }
      const parsed = parseProviderOutput(
        request,
        run.structured !== undefined ? run.structured : JSON.parse(run.text),
      );
      return {
        result: parsed.result,
        ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
        ...usageField(run.usage),
        finishReason: run.finishReason,
        toolCalls: run.toolCalls,
        messages: run.messages,
        raw: run.chunks,
      };
    }

    // A text request that ran out of tokens still has its text. It comes back
    // with `finishReason: 'length'` — the machine decides what that is worth.
    return {
      result: run.text,
      ...usageField(run.usage),
      finishReason: run.finishReason,
      toolCalls: run.toolCalls,
      messages: run.messages,
      raw: run.chunks,
    };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<TanStackAiStreamResult> => {
    // A structured request is refused; tools run in the loop, as in generateText.
    if (isStructuredOutputSchema(request.outputSchema)) {
      refuseStructuredStream(ADAPTER);
    }

    const { adapter, settings } = resolve(request, request);
    const tools = toTanStackAiTools(request.tools);
    const run = await runChat(
      {
        ...settings,
        adapter,
        ...toTanStackAiMessages(request),
        ...(tools.length > 0 ? { tools } : {}),
        agentLoopStrategy: loopBound(request),
      },
      info?.signal,
      (delta) => info?.onChunk?.(delta),
    );

    return {
      result: run.text,
      ...usageField(run.usage),
      finishReason: run.finishReason,
      messages: run.messages,
      raw: run.chunks,
    };
  };

  const decide = async (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ): Promise<TanStackAiDecideResult> => {
    const { adapter, settings } = resolve(request, { ...request, toolChoice: "required" });
    const run = await runChat(
      {
        ...settings,
        adapter,
        ...toDecisionMessages(request),
        tools: toTanStackAiEventTools(request.events),
        agentLoopStrategy: maxIterations(1),
      },
      info?.signal,
    );

    const toolCall = run.toolCalls[0];
    const chosenEvent = eventForToolCall(ADAPTER, request.events, toolCall?.toolName);

    return {
      event: toChosenEvent(chosenEvent, toolCall?.input),
      ...usageField(run.usage),
      finishReason: run.finishReason,
      raw: run.chunks,
    };
  };

  return { generateText, streamText, decide };
}
