import {
  generateText as aiGenerateText,
  NoObjectGeneratedError,
  Output,
  streamText as aiStreamText,
  stepCountIs,
  tool,
  type FinishReason,
  type FlexibleSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolSet,
  type TypedToolCall,
  type TypedToolResult,
} from "ai";
import {
  buildEnvelopeSchema,
  getAgentOutputMode,
  type AgentRequestExecutor,
  type AgentRequestExecutorInfo,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type StructuredOutputEnvelope,
} from "../text-logic.js";
import { isStandardSchema } from "../utils.js";
import { renderDecisionAttempts } from "../decision.js";
import type { AgentDecisionExecutor, AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type { AgentTools, ChosenEvent, StandardSchemaV1 } from "../types.js";

/**
 * Maps an {@link AgentTools} map onto AI SDK `tool()` definitions. A tool that
 * already carries its own Standard Schema `inputSchema` — an AI SDK
 * `tool({...})`, or any equivalent descriptor — is passed through **unchanged**,
 * so the SDK applies its own validation, calls `execute(input, options)`, and
 * every extra property (`providerOptions`, `toModelOutput`, …) survives. A bare
 * `AgentToolExecute` function becomes a tool with an unconstrained input schema;
 * a minimal descriptor with no readable schema is converted with a permissive
 * fallback. Used internally by {@link toAiSdkCallSettings}; exported for callers
 * building AI SDK calls by hand outside `createAiSdkExecutors`.
 */
export function toAiSdkTools(tools: AgentTools) {
  const entries: Array<[string, Tool<unknown, unknown> | Tool<unknown, never>]> = [];

  for (const [name, descriptor] of Object.entries(tools)) {
    if (!descriptor) {
      continue;
    }

    if (typeof descriptor === "function") {
      entries.push([
        name,
        tool({
          inputSchema: unknownSchema,
          execute: (input) => descriptor(input),
        }),
      ]);
      continue;
    }

    // Native path: the tool already exposes a Standard Schema `inputSchema`
    // (the marker `tool({...})` leaves in place), so hand it to the SDK as-is —
    // the SDK owns its typing/validation/execute(input, options), and extras
    // ride along untouched. Only descriptors with no readable schema fall
    // through to the conversion path below.
    if (isStandardSchema(descriptor.inputSchema)) {
      entries.push([name, descriptor as unknown as Tool<unknown, unknown>]);
      continue;
    }

    const inputSchema =
      descriptor.inputSchema ??
      (descriptor.schemas as { input?: StandardSchemaV1 } | undefined)?.input;
    const toolOptions = {
      description: descriptor.description,
      inputSchema: inputSchema ? (inputSchema as FlexibleSchema<unknown>) : unknownSchema,
    };

    if (descriptor.execute) {
      entries.push([
        name,
        tool({
          ...toolOptions,
          execute: (input) => descriptor.execute?.(input),
        }),
      ]);
      continue;
    }

    entries.push([name, tool(toolOptions)]);
  }

  return Object.fromEntries(entries);
}

// Multi-step tool loops: `metadata` is the host-owned per-call channel (see
// AgentTextRequest.metadata). `metadata.maxSteps` bounds the AI SDK tool-call
// loop for a request; default stays single-step. Shared by generateText and
// streamText so both honor it symmetrically.
function maxStepsSetting(request: AgentTextRequest): { stopWhen?: ReturnType<typeof stepCountIs> } {
  return typeof request.metadata?.maxSteps === "number"
    ? { stopWhen: stepCountIs(request.metadata.maxSteps) }
    : {};
}

// Permissive fallback StandardSchemaV1/FlexibleSchema used for tools/events with no declared input schema.
const unknownSchema = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({}),
    },
  },
} as unknown as StandardSchemaV1 & FlexibleSchema<unknown>;

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

/**
 * AI SDK request-mapping settings shared by `generateText`/`streamText`.
 * `AgentTextRequest.messages` (`AgentMessage[]`) and AI SDK's `ModelMessage[]`
 * are structurally compatible by design (§1 of docs/p0-design.md) — the cast
 * below is a typed identity mapping, not a semantic conversion.
 */
export function toAiSdkCallSettings(request: AgentTextRequest & { tools?: AgentTools }) {
  const messages = request.messages as ModelMessage[] | undefined;
  return {
    system: request.system,
    ...(messages ? { messages } : { prompt: request.prompt ?? "" }),
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    topP: request.topP,
    topK: request.topK,
    seed: request.seed,
    stopSequences: request.stopSequences,
    tools: request.tools ? toAiSdkTools(request.tools) : undefined,
    toolChoice: toAiSdkToolChoice(request.toolChoice),
  };
}

/** Maps an {@link AgentToolChoice} to AI SDK's tool-choice shape — `{ type: 'tool'; name }` becomes `{ type: 'tool'; toolName }`; `'auto'`/`'none'`/`'required'`/`undefined` pass through unchanged. */
export function toAiSdkToolChoice(toolChoice: AgentTextRequest["toolChoice"]) {
  return typeof toolChoice === "object"
    ? { type: "tool" as const, toolName: toolChoice.name }
    : toolChoice;
}

/** `true` when the request should use AI SDK structured `Output.object`. */
export function isStructuredOutputRequest(
  request: Pick<AgentTextRequest, "outputSchema">,
): boolean {
  return getAgentOutputMode(request.outputSchema) === "structured";
}

/**
 * Extracts the first complete top-level JSON value from `text`, or returns
 * `undefined` when there is nothing to repair (no complete value, or the value
 * already spans the whole text). Models occasionally emit two structured-output
 * envelopes back to back (`{"result":{…}}{"result":{…}}`), which fails JSON
 * parsing wholesale; the balanced scan below recovers the first value and
 * drops the rest.
 */
export function extractFirstJsonValue(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        const value = text.slice(start, i + 1);
        return value === text.trim() ? undefined : value;
      }
    }
  }
  return undefined;
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
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  toolCalls: TypedToolCall<ToolSet>[];
  toolResults: TypedToolResult<ToolSet>[];
};
/** Raw result shape from {@link AiSdkExecutors.streamText} — the `{ output }` envelope carrying the fully-accumulated text once the stream finishes (chunks are delivered separately via `onChunk`), plus the stream's final usage/finish metadata for `onResult`. */
export type AiSdkStreamResult = {
  output: string;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
};
/** Raw result shape from {@link AiSdkExecutors.decide} — the chosen event plus the AI SDK call metadata, delivered per decision attempt to `onResult`. */
export type AiSdkDecideResult = {
  event: ChosenEvent;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
};

/** `createAiSdkExecutors` always populates all three slots (unlike the
 * general `AgentRequestExecutors`, where `streamText`/`decide` are optional),
 * and its `generateText`/`streamText` results are concretely typed. */
export interface AiSdkExecutors extends AgentRequestExecutors<
  AiSdkGenerateResult,
  AiSdkStreamResult
> {
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
        reasoning: request.reasoning,
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
        usage: result.usage,
        finishReason: result.finishReason,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
      } satisfies AiSdkGenerateResult;
    }

    const result = await aiGenerateText(common);
    return {
      output: result.text,
      usage: result.usage,
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
      usage: await result.usage,
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
      usage: result.usage,
      finishReason: result.finishReason,
    } satisfies AiSdkDecideResult;
  };

  return { generateText, streamText, decide };
}

/** One AI SDK `tool()` per candidate event — the "tool-per-event +
 * toolChoice: 'required'" recipe from docs/p0-design.md §2.6. */
export function toAiSdkEventTools(events: AgentEventDescriptor[]) {
  return Object.fromEntries(
    events.map((event) => [
      event.toolName,
      tool({
        description: `Choose the '${event.type}' move.`,
        inputSchema: event.inputSchema
          ? (event.inputSchema as FlexibleSchema<unknown>)
          : unknownSchema,
      }),
    ]),
  );
}

/**
 * Messages for a decision request, with prior failed `attempts` (§2.6)
 * rendered as appended user messages (via core's {@link renderDecisionAttempts})
 * so retries converge. Core never rewrites prompts — this is adapter business.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): ModelMessage[] | undefined {
  if (!request.messages && request.attempts.length === 0) {
    return undefined;
  }

  // A prompt-authored decision that is retrying must not lose its original
  // prompt when the request is lowered to messages for attempt feedback.
  const messages: ModelMessage[] = [
    ...((request.messages as ModelMessage[] | undefined) ??
      (request.prompt !== undefined ? [{ role: "user" as const, content: request.prompt }] : [])),
  ];
  for (const attempt of renderDecisionAttempts(request)) {
    messages.push({ role: "user", content: attempt.content as string });
  }
  return messages;
}
