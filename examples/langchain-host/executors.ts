/**
 * Direction A — a LangChain chat model as the machine's executors.
 *
 * `createLangChainExecutors` wraps any `BaseChatModel` (ChatOpenAI, an
 * `initChatModel` result, a scripted fake) into the framework's three-slot
 * `{ generateText, streamText, decide }` contract. The machine keeps owning
 * control flow and legality; LangChain owns the model call.
 *
 * Because the model call is LangChain's, everything hanging off it comes
 * along for free: callbacks, retries/fallbacks, `.withConfig`, and LangSmith
 * tracing (env-var driven — `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY`
 * and every call below shows up as a trace, with no code in this file).
 *
 * Compare `../openai-sdk-host/index.ts` (same contract, raw OpenAI SDK) and
 * `../../src/ai-sdk/index.ts` (the reference adapter).
 */
import type { BaseChatModel, ToolChoice } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  buildEnvelopeSchema,
  getAgentOutputMode,
  getJsonSchema,
  getJsonSchemaSync,
  isStandardSchema,
  parseStructuredEnvelope,
  renderDecisionAttempts,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type AgentEventDescriptor,
  type AgentMessage,
  type AgentRequestExecutorInfo,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type AgentTools,
  type AgentCallUsage,
  type ChosenEvent,
} from "@statelyai/agent";

// ─── Request → LangChain mapping (pure, unit-testable) ───

/** Maps `AgentTextRequest.messages`/`system`/`prompt` to LangChain messages. */
export function toLangChainMessages(
  request: Pick<AgentTextRequest, "system" | "prompt"> & { messages?: AgentMessage[] },
): BaseMessage[] {
  if (request.messages) {
    // `AgentMessage`'s system|user|assistant|tool roles map 1:1 onto
    // LangChain's four message classes.
    return request.messages.flatMap((message): BaseMessage[] => {
      const content = typeof message.content === "string" ? message.content : "";
      switch (message.role) {
        case "system":
          return [new SystemMessage(content)];
        case "user":
          return [new HumanMessage(content)];
        case "assistant":
          return [new AIMessage(content)];
        case "tool":
          // One `ToolResultPart` per LangChain ToolMessage, each carrying its
          // own `toolCallId`.
          return message.content.map(
            (part) =>
              new ToolMessage({
                tool_call_id: part.toolCallId,
                content:
                  part.output.type === "text" || part.output.type === "error-text"
                    ? part.output.value
                    : JSON.stringify(part.output.value),
              }),
          );
      }
    });
  }

  const messages: BaseMessage[] = [];
  if (request.system) {
    messages.push(new SystemMessage(request.system));
  }
  messages.push(new HumanMessage(request.prompt ?? ""));
  return messages;
}

/**
 * Per-call options. LangChain deliberately keeps sampling settings (temperature,
 * top-p, max tokens, seed) on the *model instance*, not the call — that is the
 * whole point of Direction A: the LangChain user's own model config stays
 * authoritative. Only the two genuinely per-call knobs are forwarded here.
 */
export function toCallOptions(
  request: Pick<AgentTextRequest, "stopSequences">,
  signal?: AbortSignal,
) {
  return {
    ...(request.stopSequences ? { stop: request.stopSequences } : {}),
    ...(signal ? { signal } : {}),
  };
}

/** One LangChain tool spec per `AgentTools` entry (bound, not looped — see below). */
export function toLangChainTools(tools: AgentTools) {
  return Object.entries(tools).flatMap(([name, descriptor]) => {
    if (!descriptor) {
      return [];
    }
    const inputSchema = typeof descriptor === "function" ? undefined : descriptor.inputSchema;
    return [
      {
        name,
        description: typeof descriptor === "function" ? undefined : descriptor.description,
        schema: (isStandardSchema(inputSchema) ? getJsonSchemaSync(inputSchema) : undefined) ?? {},
      },
    ];
  });
}

/** One LangChain tool spec per candidate decision event — the tool-per-event recipe. */
export function toLangChainEventTools(events: AgentEventDescriptor[]) {
  return events.map((event) => ({
    name: event.toolName,
    description: `Choose the '${event.type}' move.`,
    schema: getJsonSchemaSync(event.inputSchema) ?? {},
  }));
}

/**
 * Messages for a decision request, with prior failed `attempts` appended as a
 * human message so retries converge. Mirrors `toDecisionMessages` in the AI SDK
 * adapter and the raw-OpenAI host.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "system" | "prompt" | "events" | "attempts">,
): BaseMessage[] {
  const messages = toLangChainMessages(request);
  for (const attempt of renderDecisionAttempts(request)) {
    messages.push(new HumanMessage(attempt.content as string));
  }
  return messages;
}

/** LangChain's `usage_metadata` → the framework's per-call `AgentCallUsage` field names. */
export function toAgentUsage(message: {
  usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}): AgentCallUsage | undefined {
  const usage = message.usage_metadata;
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

// ─── createLangChainExecutors ───

export interface LangChainExecutors extends AgentRequestExecutors {
  streamText: NonNullable<AgentRequestExecutors["streamText"]>;
  decide: AgentDecisionExecutor;
}

export interface LangChainExecutorsConfig {
  /** The model to use for every request whose ref `resolveModel` doesn't override. */
  model: BaseChatModel;
  /**
   * Maps a machine's model *ref* (e.g. `'critic'`) to a LangChain chat model.
   * A machine's requests carry refs, not provider ids, so the host resolves
   * them — the seam where a LangChain user plugs in their own configured
   * `ChatOpenAI` per request. Defaults to `model` for every ref.
   */
  resolveModel?: (modelRef: string) => BaseChatModel;
  /**
   * `tool_choice` used to force a decision's event tool. `'any'` is the
   * provider-agnostic value LangChain normalizes (ChatOpenAI maps it to
   * OpenAI's `'required'`).
   */
  decisionToolChoice?: ToolChoice;
}

function requireBindTools(model: BaseChatModel): NonNullable<BaseChatModel["bindTools"]> {
  if (!model.bindTools) {
    throw new Error(
      `createLangChainExecutors: model '${model._llmType()}' does not implement bindTools(), ` +
        `which decisions require.`,
    );
  }
  return model.bindTools.bind(model);
}

/**
 * Builds `{ generateText, streamText, decide }` from a LangChain chat model.
 *
 * Structured output goes through `withStructuredOutput`, LangChain's own
 * portable structured-output surface, applied to the `{ result, reasoning? }`
 * envelope this framework requires (see docs/hosts.md); the `.result` is
 * unwrapped and validated before it reaches the machine.
 *
 * Decisions bind one tool per candidate event and force a call — the same
 * recipe as the AI SDK adapter. Core's `resolveDecision` owns the retry loop,
 * so this executor just returns the one `{ event }` the model picked.
 *
 * Tools declared on a text request are bound but not looped: this host runs a
 * single model call per request, same as `../openai-sdk-host`. For a
 * multi-step LangChain tool loop, drive `createAgent` and give the machine
 * bridge tools instead — see `./bridge.ts`.
 */
export function createLangChainExecutors({
  model,
  resolveModel = () => model,
  decisionToolChoice = "any",
}: LangChainExecutorsConfig): LangChainExecutors {
  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => {
    const chat = resolveModel(request.model);
    const messages = toLangChainMessages(request);
    const options = toCallOptions(request, info?.signal);

    if (getAgentOutputMode(request.outputSchema) === "structured") {
      const envelope = buildEnvelopeSchema(request.outputSchema!, {
        reasoning: request.includeReasoning,
      });
      const jsonSchema = await getJsonSchema(envelope);
      if (jsonSchema) {
        const structured = chat.withStructuredOutput(jsonSchema, { name: "output" });
        const raw = await structured.invoke(messages, options);
        // Validated unwrap of the { result, reasoning? } envelope — no cast.
        const parsed = parseStructuredEnvelope(request, raw);
        return {
          output: parsed.result,
          ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
        };
      }
      // No structured output without a schema exposing `~standard.jsonSchema`
      // — falls back to text.
    }

    const tools = toLangChainTools(request.tools);
    const runnable = tools.length > 0 && chat.bindTools ? chat.bindTools(tools) : chat;
    const response = await runnable.invoke(messages, options);
    const usage = toAgentUsage(response);
    return { output: response.text, ...(usage ? { usage } : {}) };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => {
    const chat = resolveModel(request.model);
    const stream = await chat.stream(
      toLangChainMessages(request),
      toCallOptions(request, info?.signal),
    );

    let text = "";
    let usage: AgentCallUsage | undefined;
    for await (const chunk of stream) {
      // `.text` is the portable accumulator on a message chunk; `.content` may
      // be a content-block array depending on the provider.
      const delta = chunk.text;
      if (delta) {
        text += delta;
        info?.onChunk?.(delta);
      }
      usage = toAgentUsage(chunk) ?? usage;
    }
    return { output: text, ...(usage ? { usage } : {}) };
  };

  const decide: AgentDecisionExecutor = async (request, info) => {
    const chat = resolveModel(request.model);
    const bound = requireBindTools(chat)(toLangChainEventTools(request.events), {
      tool_choice: decisionToolChoice,
    });

    const response = await bound.invoke(
      toDecisionMessages(request),
      info?.signal ? { signal: info.signal } : {},
    );

    const toolCall = response.tool_calls?.[0];
    if (!toolCall) {
      throw new Error("createLangChainExecutors: decide — model did not call an event tool.");
    }
    const chosenEvent = request.events.find((event) => event.toolName === toolCall.name);
    if (!chosenEvent) {
      throw new Error(
        `createLangChainExecutors: decide — model called unknown tool '${toolCall.name}'.`,
      );
    }

    return {
      event: { ...toolCall.args, type: chosenEvent.type } as ChosenEvent,
    };
  };

  return { generateText, streamText, decide };
}
