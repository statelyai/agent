/**
 * Anthropic SDK host for XState agent machines.
 *
 * Implements the framework's `{ generateText, streamText, decide }` executor
 * contract directly against the raw `@anthropic-ai/sdk` package (Messages
 * API) with no Vercel AI SDK in between — proof that the contract is "three
 * plain functions," not an AI-SDK-specific shape. Compare with
 * `../ai-sdk-host/index.ts` (same contract, mapped through the AI SDK),
 * `../openai-sdk-host/index.ts` (same contract, raw OpenAI SDK), and
 * `../../src/ai-sdk/index.ts` (the reference adapter this file mirrors).
 *
 * Tool-result message mapping limitation: Anthropic's Messages API has no
 * `system`-role message (system is a top-level `system` param) and no
 * `tool`-role message (tool results are `tool_result` content blocks inside
 * a `user`-role message). `toAnthropicMessages` below drops `system`-role
 * entries (the top-level `system` param is the sole source of the system
 * prompt) and folds `tool`-role `AgentMessage`s into synthetic `user`
 * messages carrying `tool_result` blocks. Parts-array `user`/`assistant`
 * content is flattened to text-only (non-text parts dropped) — this is a
 * minimal, honest mapping for the example, not a complete multi-modal
 * adapter.
 *
 * Structured output uses a forced single-tool call (`tool_choice: { type:
 * 'tool', name: 'respond_with_output' }`) when `request.outputSchema`
 * exposes a Standard Schema JSON Schema (the optional `~standard.jsonSchema`
 * extension — Zod v4's `z.toJSONSchema` implements it). Schemas without that
 * extension fall back to plain text.
 *
 * Decisions force a tool call with `tool_choice: { type: 'any' }` and one
 * tool per candidate event (Anthropic has no "forced, but pick any of these
 * N tools" choice other than "any available tool" — since only the
 * candidate-event tools are ever sent, `{ type: 'any' }` is equivalent to
 * "pick one of the candidates").
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/anthropic-sdk-host/index.ts
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  Tool,
  ToolChoice,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
  getAgentOutputMode,
  runAgent,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type AgentEventDescriptor,
  type AgentMessage,
  type AgentRequestExecutorInfo,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type AgentTools,
  type ChosenEvent,
  type DecisionAttempt,
  type StandardSchemaV1,
} from "../../src/index.js";
import { triageMachine } from "../triage/index.js";
import { twentyQuestionsMachine } from "../twenty-questions/index.js";
import { runExampleMain } from "../helpers/main.js";

// ─── Request → Anthropic param mapping (pure, unit-testable) ───

/**
 * Extracts a JSON Schema from a Standard Schema's optional
 * `~standard.jsonSchema` extension (implemented by e.g. Zod v4's
 * `z.toJSONSchema`). Returns `undefined` when the schema doesn't expose one
 * — callers must fall back to plain text in that case. The extension's
 * signature allows returning a Promise; this stays synchronous and treats a
 * Promise result as absent (documented limitation, not expected in practice
 * since Zod's implementation is synchronous).
 */
export function extractJsonSchema(schema?: StandardSchemaV1): Record<string, unknown> | undefined {
  const jsonSchema = (
    schema?.["~standard"] as
      | {
          jsonSchema?: { input?: () => unknown };
        }
      | undefined
  )?.jsonSchema?.input?.();

  return jsonSchema && !(jsonSchema instanceof Promise)
    ? (jsonSchema as Record<string, unknown>)
    : undefined;
}

/**
 * Maps `AgentMessage[]` to Anthropic `MessageParam[]`. Anthropic has no
 * `system`-role message and no `tool`-role message — see the file header for
 * the documented mapping decisions:
 *   - `system`-role entries are dropped (the top-level `system` param, set
 *     from `request.system`, is the sole source of the system prompt).
 *   - `user`/`assistant` messages with string content pass through as-is.
 *     Parts-array content is flattened to text-only by concatenating `text`
 *     parts (joined with `\n`) and dropping image/file/tool-call/tool-result
 *     parts — a simplification for this example, not a complete adapter.
 *   - `tool`-role messages become a `user`-role message whose content is one
 *     `tool_result` block per `ToolResultPart`, since Anthropic requires
 *     tool results to live inside a user turn.
 */
export function toAnthropicMessages(messages: AgentMessage[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      result.push({
        role: "user",
        content: message.content.map(
          (part): ContentBlockParam => ({
            type: "tool_result",
            tool_use_id: part.toolCallId,
            content:
              part.output.type === "text" || part.output.type === "error-text"
                ? part.output.value
                : JSON.stringify(part.output.value),
            ...(part.output.type === "error-text" || part.output.type === "error-json"
              ? { is_error: true }
              : {}),
          }),
        ),
      });
      continue;
    }

    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    result.push({ role: message.role, content: text });
  }

  return result;
}

/**
 * Maps sampling/stop settings. Anthropic requires `max_tokens` (unlike
 * OpenAI, where it's optional) — this defaults it to 1024 when the request
 * doesn't specify one. `seed` has no Anthropic equivalent and is dropped.
 */
export function toAnthropicCallSettings(request: AgentTextRequest) {
  return {
    max_tokens: request.maxOutputTokens ?? 1024,
    temperature: request.temperature,
    top_p: request.topP,
    top_k: request.topK,
    stop_sequences: request.stopSequences,
    // No Anthropic equivalent for `seed` — dropped.
  };
}

/** One Anthropic tool per `AgentTools` entry. */
export function toAnthropicTools(tools: AgentTools): Tool[] {
  return Object.entries(tools).flatMap(([name, descriptor]) => {
    if (!descriptor) {
      return [];
    }
    const inputSchema = typeof descriptor === "function" ? undefined : descriptor.inputSchema;
    const jsonSchema = extractJsonSchema(inputSchema);
    return [
      {
        name,
        description: typeof descriptor === "function" ? undefined : descriptor.description,
        input_schema: { type: "object" as const, ...jsonSchema },
      },
    ];
  });
}

/** One Anthropic tool per candidate decision event. */
export function toAnthropicEventTools(events: AgentEventDescriptor[]): Tool[] {
  return events.map((event) => {
    const jsonSchema = extractJsonSchema(event.inputSchema);
    return {
      name: event.toolName,
      description: `Choose the '${event.type}' move.`,
      input_schema: { type: "object" as const, ...jsonSchema },
    };
  });
}

/**
 * Messages for a decision request, with prior failed `attempts` rendered as
 * an appended user message so retries converge. Mirrors `toDecisionMessages`
 * in `src/ai-sdk/index.ts` and `examples/openai-sdk-host/index.ts`.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): MessageParam[] {
  const messages: MessageParam[] = request.messages
    ? toAnthropicMessages(request.messages)
    : request.prompt !== undefined
      ? [{ role: "user", content: request.prompt }]
      : [];

  for (const attempt of request.attempts) {
    messages.push({ role: "user", content: attemptFeedback(attempt, request.events) });
  }
  return messages;
}

function attemptFeedback(attempt: DecisionAttempt, events: AgentEventDescriptor[]): string {
  const types = events.map((event) => event.type).join(", ") || "(none)";
  return `Your previous choice failed: ${attempt.reason}. Choose again from: ${types}`;
}

/** The synthetic tool used to force structured output via a tool call. */
const STRUCTURED_OUTPUT_TOOL_NAME = "respond_with_output";

// ─── createAnthropicExecutors ───

export interface CreateAnthropicExecutorsOptions {
  client: Anthropic;
  /**
   * Maps a machine's model *ref* (e.g. 'ticketTriage') to a real Anthropic
   * model id. A machine's requests carry model refs, not ids, so a raw-SDK host
   * must resolve them (the AI SDK adapter does this via its `models` map).
   * Defaults to identity for machines that already use real ids.
   */
  resolveModel?: (modelRef: string) => string;
}

export type AnthropicGenerateResult = { output: unknown; [key: string]: unknown };
export type AnthropicStreamResult = { output: string; [key: string]: unknown };

export interface AnthropicExecutors extends AgentRequestExecutors<
  AnthropicGenerateResult,
  AnthropicStreamResult
> {
  streamText: NonNullable<
    AgentRequestExecutors<AnthropicGenerateResult, AnthropicStreamResult>["streamText"]
  >;
  decide: AgentDecisionExecutor;
}

/**
 * Builds the `{ generateText, streamText, decide }` executor set for the raw
 * `@anthropic-ai/sdk` package's Messages API. Compare `createAiSdkExecutors`
 * in `src/ai-sdk/index.ts` — same shape, different SDK underneath.
 */
export function createAnthropicExecutors(
  options: CreateAnthropicExecutorsOptions,
): AnthropicExecutors {
  const { client, resolveModel = (modelRef: string) => modelRef } = options;

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<AnthropicGenerateResult> => {
    const messages = request.messages
      ? toAnthropicMessages(request.messages)
      : [{ role: "user" as const, content: request.prompt ?? "" }];
    const common = {
      model: resolveModel(request.model),
      system: request.system,
      messages,
      ...toAnthropicCallSettings(request),
    };

    if (getAgentOutputMode(request.outputSchema) === "structured") {
      const jsonSchema = extractJsonSchema(request.outputSchema);
      if (jsonSchema) {
        const tool: Tool = {
          name: STRUCTURED_OUTPUT_TOOL_NAME,
          description: "Provide the final structured output.",
          input_schema: { type: "object", ...jsonSchema },
        };
        const toolChoice: ToolChoice = { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME };
        const response = await client.messages.create(
          { ...common, tools: [tool], tool_choice: toolChoice },
          { signal: info?.signal },
        );
        const toolUse = response.content.find(
          (block): block is Extract<typeof block, { type: "tool_use" }> =>
            block.type === "tool_use" && block.name === STRUCTURED_OUTPUT_TOOL_NAME,
        );
        return { output: toolUse?.input };
      }
      // No JSON Schema extension available on this schema (e.g. a hand-rolled
      // StandardSchemaV1 without `~standard.jsonSchema`) — fall back to text.
    }

    const tools = toAnthropicTools(request.tools);
    const response = await client.messages.create(
      { ...common, ...(tools.length > 0 ? { tools } : {}) },
      { signal: info?.signal },
    );
    return { output: extractText(response) };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<AnthropicStreamResult> => {
    const messages = request.messages
      ? toAnthropicMessages(request.messages)
      : [{ role: "user" as const, content: request.prompt ?? "" }];
    const tools = toAnthropicTools(request.tools);
    const stream = client.messages.stream(
      {
        model: resolveModel(request.model),
        system: request.system,
        messages,
        ...toAnthropicCallSettings(request),
        ...(tools.length > 0 ? { tools } : {}),
      },
      { signal: info?.signal },
    );
    stream.on("text", (delta) => info?.onChunk?.(delta));
    return { output: await stream.finalText() };
  };

  const decide: AgentDecisionExecutor = async (request) => {
    const tools = toAnthropicEventTools(request.events);

    const response = await client.messages.create({
      model: resolveModel(request.model),
      system: request.system,
      messages: toDecisionMessages(request),
      tools,
      // No Anthropic tool_choice forces "one of exactly these N tools" other
      // than sending only those N tools with `{ type: 'any' }` ("use any
      // available tool") — since `tools` here is exactly the candidate-event
      // set, `{ type: 'any' }` is equivalent to "pick one of the candidates".
      tool_choice: { type: "any" },
      ...toAnthropicCallSettings(request),
    });

    const toolUse = response.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("createAnthropicExecutors: decide — model did not call an event tool.");
    }
    const chosenEvent = request.events.find((event) => event.toolName === toolUse.name);
    if (!chosenEvent) {
      throw new Error(
        `createAnthropicExecutors: decide — model called unknown tool '${toolUse.name}'.`,
      );
    }

    const input = toolUse.input;
    return {
      event: {
        ...(input && typeof input === "object" ? input : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
    };
  };

  return { generateText, streamText, decide };
}

function extractText(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// ─── Demo host ───

// The demo machines (triage, twenty-questions) carry model refs that both map
// to one real Anthropic id — a raw-SDK host resolves them itself.
const resolveDemoModel = () => "claude-haiku-4-5";

export async function runTriageDemo(client: Anthropic, ticket: string) {
  const { generateText } = createAnthropicExecutors({ client, resolveModel: resolveDemoModel });
  const result = await runAgent(triageMachine, {
    input: { ticket },
    generateText,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });
  if (result.status !== "done") {
    if (result.status === "error") console.error(result.error);
    throw new Error(`Triage demo did not complete: ${result.status}`);
  }
  return result.output;
}

async function promptAnswer(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

export async function runTwentyQuestionsDemo(client: Anthropic) {
  const { generateText, decide } = createAnthropicExecutors({
    client,
    resolveModel: resolveDemoModel,
  });
  const result = await runAgent(twentyQuestionsMachine, {
    input: { questionsRemaining: 20 },
    generateText,
    decide,
    userInput: async ({ prompt }) => promptAnswer(prompt ?? ">"),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });
  if (result.status !== "done") {
    throw new Error(`Twenty questions demo did not complete: ${result.status}`);
  }
  return result.output;
}

async function main() {
  const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
  const client = new AnthropicClient();

  console.log("— generateText (structured output via forced tool call) —");
  console.log(await runTriageDemo(client, "My invoice is wrong and I am furious."));

  console.log('— decide (tool_choice: { type: "any" }) —');
  const result = await runTwentyQuestionsDemo(client);
  console.log(`Final score — user: ${result.userScore}, agent: ${result.agentScore}`);
}

runExampleMain(import.meta.url, main, { requireEnv: "ANTHROPIC_API_KEY" });
