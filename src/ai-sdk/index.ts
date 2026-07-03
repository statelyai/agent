import {
  generateText as aiGenerateText,
  Output,
  streamText as aiStreamText,
  stepCountIs,
  tool,
  type FlexibleSchema,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from 'ai';
import {
  getAgentOutputMode,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type AgentEventDescriptor,
  type AgentRequestExecutor,
  type AgentRequestExecutorInfo,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type DecisionAttempt,
} from '../setup-agent.js';
import type { AgentTools, ChosenEvent, StandardSchemaV1 } from '../types.js';

export function toAiSdkTools(tools: AgentTools) {
  const entries: Array<[string, Tool<unknown, unknown> | Tool<unknown, never>]> = [];

  for (const [name, descriptor] of Object.entries(tools)) {
    if (!descriptor) {
      continue;
    }

    if (typeof descriptor === 'function') {
      entries.push([name, tool({
        inputSchema: unknownSchema,
        execute: (input) => descriptor(input),
      })]);
      continue;
    }

    const inputSchema =
      descriptor.inputSchema
      ?? (descriptor.schemas as { input?: StandardSchemaV1 } | undefined)?.input;
    const toolOptions = {
      description: descriptor.description,
      inputSchema: inputSchema
        ? inputSchema as FlexibleSchema<unknown>
        : unknownSchema,
    };

    if (descriptor.execute) {
      entries.push([name, tool({
        ...toolOptions,
        execute: (input) => descriptor.execute?.(input),
      })]);
      continue;
    }

    entries.push([name, tool(toolOptions)]);
  }

  return Object.fromEntries(entries);
}

const unknownSchema = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({}),
    },
  },
} as unknown as StandardSchemaV1 & FlexibleSchema<unknown>;

// ─── createAiSdkExecutors ───

export type AiSdkModelMap = Record<string, LanguageModel>;

export type CreateAiSdkExecutorsOptions<
  TModels extends AiSdkModelMap = AiSdkModelMap,
> =
  | {
      models: TModels;
      resolveModel?: (modelRef: keyof TModels & string) => LanguageModel;
    }
  | {
      models?: TModels;
      resolveModel: (modelRef: string) => LanguageModel;
    };

function resolveAiSdkModel<TModels extends AiSdkModelMap>(
  options: CreateAiSdkExecutorsOptions<TModels>,
  modelRef: string
): LanguageModel {
  if (options.resolveModel) {
    return options.resolveModel(modelRef as keyof TModels & string);
  }

  const models = options.models;
  if (!models) {
    throw new Error(
      `createAiSdkExecutors: no model resolver configured for '${modelRef}'.`
    );
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
export function toAiSdkCallSettings(
  request: AgentTextRequest & { tools?: AgentTools }
) {
  const messages = request.messages as ModelMessage[] | undefined;
  return {
    system: request.system,
    ...(messages ? { messages } : { prompt: request.prompt ?? '' }),
    temperature: request.temperature,
    maxOutputTokens: request.maxTokens,
    topP: request.topP,
    topK: request.topK,
    seed: request.seed,
    stopSequences: request.stopSequences,
    tools: request.tools ? toAiSdkTools(request.tools) : undefined,
    toolChoice: toAiSdkToolChoice(request.toolChoice),
  };
}

export function toAiSdkToolChoice(toolChoice: AgentTextRequest['toolChoice']) {
  return typeof toolChoice === 'object'
    ? { type: 'tool' as const, toolName: toolChoice.name }
    : toolChoice;
}

/** `true` when the request should use AI SDK structured `Output.object`. */
export function isStructuredOutputRequest(
  request: Pick<AgentTextRequest, 'outputSchema'>
): boolean {
  return getAgentOutputMode(request.outputSchema) === 'structured';
}

export type AiSdkGenerateResult = { output: unknown } | { text: string };
export type AiSdkStreamResult = { text: string };

/** `createAiSdkExecutors` always populates all three slots (unlike the
 * general `AgentRequestExecutors`, where `streamText`/`decide` are optional),
 * and its `generateText`/`streamText` results are concretely typed. */
export interface AiSdkExecutors
  extends AgentRequestExecutors<AiSdkGenerateResult, AiSdkStreamResult> {
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
 */
export function createAiSdkExecutors<TModels extends AiSdkModelMap>(
  options: CreateAiSdkExecutorsOptions<TModels>
): AiSdkExecutors {
  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo
  ) => {
    const model = resolveAiSdkModel(options, request.model);
    const common = {
      model,
      abortSignal: info?.signal,
      ...toAiSdkCallSettings(request),
      // Multi-step tool loops: `metadata` is the host-owned per-call channel
      // (see AgentTextRequest.metadata). `metadata.maxSteps` bounds the AI
      // SDK tool-call loop for this request; default stays single-step.
      ...(typeof request.metadata?.maxSteps === 'number'
        ? { stopWhen: stepCountIs(request.metadata.maxSteps) }
        : {}),
    };

    if (isStructuredOutputRequest(request)) {
      const { output } = await aiGenerateText({
        ...common,
        output: Output.object({
          schema: request.outputSchema as FlexibleSchema<unknown>,
        }),
      });
      return { output };
    }

    const { text } = await aiGenerateText(common);
    return { text };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo
  ) => {
    const model = resolveAiSdkModel(options, request.model);
    const result = aiStreamText({
      model,
      abortSignal: info?.signal,
      ...toAiSdkCallSettings(request),
    });

    for await (const chunk of result.textStream) {
      info?.onChunk?.(chunk);
    }

    return { text: await result.text };
  };

  const decide: AgentDecisionExecutor = async (request) => {
    const model = resolveAiSdkModel(options, request.model);
    const tools = toAiSdkEventTools(request.events);
    const messages = toDecisionMessages(request);

    const result = await aiGenerateText({
      model,
      system: request.system,
      ...(messages ? { messages } : { prompt: request.prompt ?? '' }),
      tools,
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      topP: request.topP,
      topK: request.topK,
      seed: request.seed,
      stopSequences: request.stopSequences,
    });

    const toolCall = result.toolCalls[0];
    if (!toolCall) {
      throw new Error('createAiSdkExecutors: decide — model did not call an event tool.');
    }
    const chosenEvent = request.events.find((event) => event.toolName === toolCall.toolName);
    if (!chosenEvent) {
      throw new Error(
        `createAiSdkExecutors: decide — model called unknown tool '${toolCall.toolName}'.`
      );
    }

    return {
      event: {
        ...(toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
    };
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
          ? event.inputSchema as FlexibleSchema<unknown>
          : unknownSchema,
      }),
    ])
  );
}

/**
 * Messages for a decision request, with prior failed `attempts` (§2.6)
 * rendered as an appended user message so retries converge. Core never
 * rewrites prompts — this is adapter business.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, 'messages' | 'prompt' | 'events' | 'attempts'>
): ModelMessage[] | undefined {
  if (!request.messages && request.attempts.length === 0) {
    return undefined;
  }

  // A prompt-authored decision that is retrying must not lose its original
  // prompt when the request is lowered to messages for attempt feedback.
  const messages: ModelMessage[] = [
    ...(request.messages as ModelMessage[] | undefined
      ?? (request.prompt !== undefined
        ? [{ role: 'user' as const, content: request.prompt }]
        : [])),
  ];
  for (const attempt of request.attempts) {
    messages.push({
      role: 'user',
      content: attemptFeedback(attempt, request.events),
    });
  }
  return messages;
}

function attemptFeedback(attempt: DecisionAttempt, events: AgentEventDescriptor[]): string {
  const types = events.map((event) => event.type).join(', ') || '(none)';
  return `Your previous choice failed: ${attempt.reason}. Choose again from: ${types}`;
}
