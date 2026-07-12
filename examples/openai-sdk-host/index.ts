/**
 * Raw `openai` npm package host for XState agent machines.
 *
 * NOTE: for the OpenAI Chat Completions *wire* format (Groq, Together, Ollama,
 * vLLM, OpenRouter, LM Studio, OpenAI itself), the shipped
 * `@statelyai/agent/openai-compat` adapter (`createOpenAiCompatExecutors`) is
 * the batteries-included path — a complete `{ generateText, streamText, decide }`
 * set over raw `fetch`, zero dependencies. This example stays as the
 * hand-rolled-against-the-official-`openai`-SDK teaching artifact.
 *
 * Implements the framework's `{ generateText, streamText, decide }` executor
 * contract directly against the raw `openai` package's Chat Completions API
 * (not the `responses` API — chat.completions is the canonical/stable
 * surface), with no Vercel AI SDK in between. Proof that the executor
 * contract is "three plain functions," not an AI-SDK-specific shape.
 * Compare `../ai-sdk-host/index.ts` (same contract, mapped through the AI
 * SDK) and `../../src/ai-sdk/index.ts` (the reference adapter this file
 * mirrors).
 *
 * Structured output uses `response_format: { type: 'json_schema', ... }`
 * when `request.outputSchema` exposes a Standard Schema JSON Schema (the
 * optional `~standard.jsonSchema` extension — e.g. Zod v4's
 * `z.toJSONSchema`). Schemas without that extension fall back to plain text.
 *
 * Decisions force a tool call with `tool_choice: 'required'` and one
 * function tool per candidate event (same recipe as the AI SDK adapter).
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/openai-sdk-host/index.ts
 */
import type OpenAI from "openai";
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions/completions.js";
import {
  getAgentOutputMode,
  runAgent,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type AgentEventDescriptor,
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

// ─── Request → OpenAI param mapping (pure, unit-testable) ───

/**
 * Extracts a JSON Schema from a Standard Schema's optional
 * `~standard.jsonSchema` extension (implemented by e.g. Zod v4's
 * `z.toJSONSchema`). The extension's signature allows returning a `Promise`
 * per the StandardSchemaV1 contract — this helper awaits it when so. Returns
 * `undefined` when the schema doesn't expose the extension at all.
 */
export async function extractJsonSchema(
  schema?: StandardSchemaV1,
): Promise<Record<string, unknown> | undefined> {
  const jsonSchemaFn = schema?.["~standard"].jsonSchema?.input;
  if (!jsonSchemaFn) {
    return undefined;
  }
  const result = jsonSchemaFn();
  const resolved = result instanceof Promise ? await result : result;
  return resolved as Record<string, unknown> | undefined;
}

/**
 * Sync-only variant for call sites that build OpenAI tool/event descriptors
 * outside an async context (`toOpenAiTools`, `toOpenAiEventTools`). If the
 * schema's `~standard.jsonSchema.input()` returns a `Promise`, its schema is
 * treated as absent here (falls back to `{}` — an empty-parameters tool),
 * since these call sites can't await. In practice the schema compilers used
 * across these examples (e.g. Zod's `z.toJSONSchema`) resolve synchronously.
 */
function extractJsonSchemaSync(schema?: StandardSchemaV1): Record<string, unknown> | undefined {
  const jsonSchemaFn = schema?.["~standard"].jsonSchema?.input;
  if (!jsonSchemaFn) {
    return undefined;
  }
  const result = jsonSchemaFn();
  return result instanceof Promise ? undefined : (result as Record<string, unknown> | undefined);
}

/** Maps `AgentTextRequest.messages`/`system`/`prompt` to OpenAI chat messages. */
export function toOpenAiMessages(
  request: Pick<AgentTextRequest, "system" | "prompt" | "messages">,
): ChatCompletionMessageParam[] {
  if (request.messages) {
    // AgentMessage's `system|user|assistant|tool` roles map 1:1 onto
    // OpenAI's message roles; only plain string content is exercised by
    // these examples, which is directly compatible with OpenAI's content
    // union for each role.
    return request.messages.flatMap((message): ChatCompletionMessageParam[] => {
      const content = typeof message.content === "string" ? message.content : "";
      switch (message.role) {
        case "system":
          return [{ role: "system", content }];
        case "user":
          return [{ role: "user", content }];
        case "assistant":
          return [{ role: "assistant", content }];
        case "tool":
          // A `ToolMessage` carries one or more `ToolResultPart`s, each with
          // its own `toolCallId`; OpenAI's tool role is one message per result.
          return message.content.map((part) => ({
            role: "tool",
            content:
              part.output.type === "text" || part.output.type === "error-text"
                ? part.output.value
                : JSON.stringify(part.output.value),
            tool_call_id: part.toolCallId,
          }));
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

/** Maps sampling/stop settings. `max_tokens` is deprecated by OpenAI SDK v6
 * in favor of `max_completion_tokens`, so that's what this targets. */
export function toOpenAiCallSettings(request: AgentTextRequest) {
  return {
    temperature: request.temperature,
    max_completion_tokens: request.maxOutputTokens,
    top_p: request.topP,
    seed: request.seed,
    stop: request.stopSequences,
    // OpenAI Chat Completions has no top_k parameter — dropped.
  };
}

/** One OpenAI function tool per `AgentTools` entry. */
export function toOpenAiTools(tools: AgentTools): ChatCompletionFunctionTool[] {
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
          description: typeof descriptor === "function" ? undefined : descriptor.description,
          parameters: extractJsonSchemaSync(inputSchema) ?? {},
        },
      },
    ];
  });
}

/** One OpenAI function tool per candidate decision event — the "tool-per-event
 * + tool_choice: 'required'" recipe, mirroring `toAiSdkEventTools`. */
export function toOpenAiEventTools(events: AgentEventDescriptor[]): ChatCompletionFunctionTool[] {
  return events.map((event) => ({
    type: "function" as const,
    function: {
      name: event.toolName,
      description: `Choose the '${event.type}' move.`,
      parameters: extractJsonSchemaSync(event.inputSchema) ?? {},
    },
  }));
}

/**
 * Messages for a decision request, with prior failed `attempts` rendered as
 * an appended user message so retries converge. Mirrors `toDecisionMessages`
 * in `src/ai-sdk/index.ts`.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): ChatCompletionMessageParam[] {
  const messages = toOpenAiMessages(request);
  for (const attempt of request.attempts) {
    messages.push({ role: "user", content: attemptFeedback(attempt, request.events) });
  }
  return messages;
}

function attemptFeedback(attempt: DecisionAttempt, events: AgentEventDescriptor[]): string {
  const types = events.map((event) => event.type).join(", ") || "(none)";
  return `Your previous choice failed: ${attempt.reason}. Choose again from: ${types}`;
}

// ─── createOpenAiExecutors ───

export interface OpenAiExecutors extends AgentRequestExecutors {
  streamText: NonNullable<AgentRequestExecutors["streamText"]>;
  decide: AgentDecisionExecutor;
}

/**
 * Builds the `{ generateText, streamText, decide }` executor set for the raw
 * `openai` package's Chat Completions API. Compare `createAiSdkExecutors` in
 * `src/ai-sdk/index.ts` — same shape, different SDK underneath.
 *
 * `resolveModel` maps a machine's model *ref* (e.g. 'ticketTriage') to a real
 * OpenAI model id. A machine's requests carry model refs, not ids, so a raw-SDK
 * host must resolve them (the AI SDK adapter does this via its `models` map).
 * Defaults to identity for machines that already use real ids.
 */
export function createOpenAiExecutors({
  client,
  resolveModel = (modelRef: string) => modelRef,
}: {
  client: OpenAI;
  resolveModel?: (modelRef: string) => string;
}): OpenAiExecutors {
  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => {
    const messages = toOpenAiMessages(request);
    const tools = toOpenAiTools(request.tools);
    const common = {
      model: resolveModel(request.model),
      messages,
      ...toOpenAiCallSettings(request),
      ...(tools.length > 0 ? { tools } : {}),
    };

    if (getAgentOutputMode(request.outputSchema) === "structured") {
      const jsonSchema = await extractJsonSchema(request.outputSchema);
      if (jsonSchema) {
        const response = await client.chat.completions.create(
          {
            ...common,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "output",
                schema: jsonSchema,
                // Arbitrary JSON Schema (e.g. from Zod) may use features
                // outside OpenAI's strict-mode subset (defaults, unions,
                // etc.) — leaving strict mode off keeps this general rather
                // than requiring schema authors to hand-tune for OpenAI.
                strict: false,
              },
            },
          },
          { signal: info?.signal },
        );
        const content = response.choices[0]?.message.content;
        return { output: content ? JSON.parse(content) : undefined };
      }
      // no structured output without a schema exposing ~standard.jsonSchema
      // — falls back to text.
    }

    const response = await client.chat.completions.create(common, { signal: info?.signal });
    return { output: response.choices[0]?.message.content ?? "" };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => {
    const stream = await client.chat.completions.create(
      {
        model: resolveModel(request.model),
        messages: toOpenAiMessages(request),
        ...toOpenAiCallSettings(request),
        stream: true,
      },
      { signal: info?.signal },
    );

    let text = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (delta) {
        text += delta;
        info?.onChunk?.(delta);
      }
    }
    return { output: text };
  };

  const decide: AgentDecisionExecutor = async (request) => {
    const tools = toOpenAiEventTools(request.events);

    const response = await client.chat.completions.create({
      model: resolveModel(request.model),
      messages: toDecisionMessages(request),
      tools,
      tool_choice: "required" as ChatCompletionToolChoiceOption,
      temperature: request.temperature,
      max_completion_tokens: request.maxOutputTokens,
      top_p: request.topP,
      stop: request.stopSequences,
      seed: request.seed,
    });

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
      event: {
        ...(args && typeof args === "object" ? args : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
    };
  };

  return { generateText, streamText, decide };
}

// ─── Demo host ───

async function promptAnswer(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

// The demo machines (triage, twenty-questions) carry model refs that both map
// to one real OpenAI id — a raw-SDK host resolves them itself.
const resolveDemoModel = () => "gpt-5.4-mini";

export async function runTriageDemo(client: OpenAI, ticket: string) {
  const { generateText } = createOpenAiExecutors({ client, resolveModel: resolveDemoModel });
  const result = await runAgent(triageMachine, {
    input: { ticket },
    generateText,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });
  if (result.status !== "done") {
    throw new Error(`Triage demo did not complete: ${result.status}`);
  }
  return result.output;
}

export async function runStreamingDemo(client: OpenAI) {
  const { streamText } = createOpenAiExecutors({ client });
  let text = "";
  await streamText(
    {
      model: "gpt-5.4-mini",
      system: "You tell short, punchy jokes.",
      prompt: "Tell a joke about state machines.",
      tools: {},
    },
    { onChunk: (chunk) => (text += chunk) },
  );
  return text;
}

// Drives twenty-questions' inline `agent.decide` + machine-owned human-input
// states via the `userInput` executor — the same human-loop pattern
// twenty-questions/index.ts's own main() uses (no host-side idle/event loop
// or fabricated events; `runAgent` gathers input inline via `userInput`).
export async function runTwentyQuestionsDemo(client: OpenAI) {
  const { generateText, decide } = createOpenAiExecutors({
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
  const { default: OpenAIClient } = await import("openai");
  const client = new OpenAIClient();

  console.log("— generateText (structured output via response_format) —");
  console.log(await runTriageDemo(client, "My invoice is wrong and I am furious."));

  console.log("— streamText (live chunks) —");
  console.log(await runStreamingDemo(client));

  console.log("— decide (tool_choice: required) —");
  const result = await runTwentyQuestionsDemo(client);
  console.log(`Final score — user: ${result.userScore}, agent: ${result.agentScore}`);
}

runExampleMain(import.meta.url, main);
