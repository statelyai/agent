import { describe, expect, test } from "vitest";
import { z } from "zod";
import { EventType, type StreamChunk, type TextOptions, type TokenUsage } from "@tanstack/ai";
import {
  BaseTextAdapter,
  type StructuredOutputOptions,
  type StructuredOutputResult,
} from "@tanstack/ai/adapters";
import type { AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type { AgentTextRequest } from "../text-logic.js";
import type { AgentTools } from "../types.js";
import { AgentTruncatedError, createAgentRuntime, runToQuiescence, setupAgent } from "../index.js";
import {
  createTanStackAiExecutors,
  toDecisionMessages,
  toTanStackAiMessages,
  toTanStackAiModelOptions,
} from "./index.js";

// ─── A scripted TanStack AI text adapter ───

type FakeResponse = {
  text?: string;
  toolCalls?: Array<{ name: string; input?: unknown }>;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  usage?: TokenUsage;
  error?: { message: string; code?: string };
};

/**
 * Answers each model turn from a queue, streaming the AG-UI chunks a real
 * provider adapter yields, and records every request it saw. `name` stands in
 * for the provider, so the per-provider `modelOptions` mapping is exercised.
 * Like the OpenAI adapter, it takes a structured output schema on the same
 * call as tools, and answers it with JSON text.
 */
class FakeTextAdapter extends BaseTextAdapter<string, Record<string, any>, ["text"], any> {
  readonly name: string;
  readonly requests: TextOptions[] = [];
  private queue: FakeResponse[];

  constructor(responses: FakeResponse[], name = "fake") {
    super({}, "fake-model");
    this.name = name;
    this.queue = [...responses];
  }

  supportsCombinedToolsAndSchema = () => true;

  async *chatStream(options: TextOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const response = this.queue.shift() ?? { error: { message: "no response queued" } };
    const base = { model: this.model, timestamp: 0 };
    const runId = `run-${this.requests.length}`;
    yield { type: EventType.RUN_STARTED, runId, threadId: "t", ...base } as StreamChunk;
    if (response.error) {
      yield {
        type: EventType.RUN_ERROR,
        message: response.error.message,
        code: response.error.code,
        ...base,
      } as StreamChunk;
      return;
    }
    if (response.text) {
      const messageId = `${runId}-text`;
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        ...base,
      } as StreamChunk;
      for (let i = 0; i < response.text.length; i += 4) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: response.text.slice(i, i + 4),
          ...base,
        } as StreamChunk;
      }
      yield { type: EventType.TEXT_MESSAGE_END, messageId, ...base } as StreamChunk;
    }
    const toolCalls = response.toolCalls ?? [];
    for (const [index, call] of toolCalls.entries()) {
      const toolCallId = `${runId}-call-${index}`;
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: call.name,
        toolName: call.name,
        index,
        ...base,
      } as StreamChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: JSON.stringify(call.input ?? {}),
        ...base,
      } as StreamChunk;
      yield { type: EventType.TOOL_CALL_END, toolCallId, ...base } as StreamChunk;
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId: "t",
      finishReason: response.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      usage: response.usage ?? { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      ...base,
    } as StreamChunk;
  }

  async structuredOutput(
    options: StructuredOutputOptions<any>,
  ): Promise<StructuredOutputResult<unknown>> {
    this.requests.push(options.chatOptions);
    const response = this.queue.shift() ?? { error: { message: "no response queued" } };
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    const rawText = response.text ?? "";
    return { data: JSON.parse(rawText), rawText };
  }
}

function textRequest(overrides: Partial<AgentTextRequest> = {}): AgentTextRequest & {
  tools: AgentTools;
} {
  return { model: "quick", prompt: "hi", tools: {}, ...overrides } as AgentTextRequest & {
    tools: AgentTools;
  };
}

const events: AgentEventDescriptor[] = [
  {
    type: "APPROVE",
    toolName: "approve",
    inputSchema: z.object({ note: z.string() }),
  } as AgentEventDescriptor,
  { type: "REJECT", toolName: "reject" } as AgentEventDescriptor,
];

function decisionRequest(overrides: Partial<AgentDecisionRequest> = {}): AgentDecisionRequest {
  return {
    model: "quick",
    prompt: "Approve or reject?",
    events,
    attempts: [],
    ...overrides,
  } as AgentDecisionRequest;
}

// ─── generateText ───

describe("createTanStackAiExecutors — generateText", () => {
  test("returns the text, the run's usage and finish reason, and the chunks", async () => {
    const adapter = new FakeTextAdapter([
      {
        text: "Hello there",
        usage: {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
          promptTokensDetails: { cachedTokens: 3 },
          completionTokensDetails: { reasoningTokens: 1 },
        },
      },
    ]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    const result = await generateText(textRequest({ system: "Be brief." }));

    expect(result.result).toBe("Hello there");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 3,
      reasoningTokens: 1,
    });
    expect(result.raw.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(true);
    expect(adapter.requests[0]!.systemPrompts).toEqual(["Be brief."]);
    expect(adapter.requests[0]!.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("a text request that ran out of tokens keeps its text and reports 'length'", async () => {
    const adapter = new FakeTextAdapter([{ text: "Half a sen", finishReason: "length" }]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    const result = await generateText(textRequest());

    expect(result.result).toBe("Half a sen");
    expect(result.finishReason).toBe("length");
  });

  test("a RUN_ERROR chunk is thrown with its message and code", async () => {
    const adapter = new FakeTextAdapter([{ error: { message: "rate limited", code: "429" } }]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    await expect(generateText(textRequest())).rejects.toMatchObject({
      message: "rate limited",
      code: "429",
    });
  });

  test("an unknown model ref throws", async () => {
    const { generateText } = createTanStackAiExecutors({
      models: { quick: new FakeTextAdapter([]) },
    });
    await expect(generateText(textRequest({ model: "slow" }))).rejects.toThrow(
      "unknown model 'slow'",
    );
  });

  test("resolveModel resolves refs dynamically", async () => {
    const adapter = new FakeTextAdapter([{ text: "ok" }]);
    const seen: string[] = [];
    const { generateText } = createTanStackAiExecutors({
      resolveModel: (ref: string) => {
        seen.push(ref);
        return adapter;
      },
    });

    expect((await generateText(textRequest({ model: "openai/gpt-5.4-mini" }))).result).toBe("ok");
    expect(seen).toEqual(["openai/gpt-5.4-mini"]);
  });
});

describe("createTanStackAiExecutors — structured output", () => {
  test("sends the { result } envelope as the output schema and unwraps it", async () => {
    const adapter = new FakeTextAdapter([{ text: '{"result":{"title":"Hi"}}' }]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    const result = await generateText(
      textRequest({ outputSchema: z.object({ title: z.string() }) }),
    );

    expect(result.result).toEqual({ title: "Hi" });
    expect(result.reasoning).toBeUndefined();
    const schema = adapter.requests.at(-1)!.outputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(["result"]);
  });

  test("reasoning opt-in adds a reasoning property and surfaces it on the result", async () => {
    const adapter = new FakeTextAdapter([
      { text: '{"result":{"title":"Hi"},"reasoning":"short is kind"}' },
    ]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    const result = await generateText(
      textRequest({ outputSchema: z.object({ title: z.string() }), includeReasoning: true }),
    );

    expect(result.result).toEqual({ title: "Hi" });
    expect(result.reasoning).toBe("short is kind");
  });

  test("a structured run cut off by the token limit is an AgentTruncatedError", async () => {
    const adapter = new FakeTextAdapter([
      { error: { message: "max_output_tokens", code: "incomplete" } },
    ]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    await expect(
      generateText(textRequest({ outputSchema: z.object({ title: z.string() }) })),
    ).rejects.toBeInstanceOf(AgentTruncatedError);
  });
});

describe("createTanStackAiExecutors — tools", () => {
  const lookup = {
    description: "Look up a city's weather.",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => ({ city, temp: 20 }),
  };

  test("tools run in chat()'s loop within maxSteps, and usage is summed over turns", async () => {
    const adapter = new FakeTextAdapter([
      { toolCalls: [{ name: "lookup", input: { city: "Oslo" } }] },
      { text: "It is 20 degrees in Oslo." },
    ]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    const result = await generateText(
      textRequest({ tools: { lookup } as unknown as AgentTools, maxSteps: 2 }),
    );

    expect(result.result).toBe("It is 20 degrees in Oslo.");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: "lookup", input: { city: "Oslo" } }),
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    // The tool's JSON Schema reached the adapter, and its result was fed back.
    const [first, second] = adapter.requests;
    expect(first!.tools?.[0]).toMatchObject({
      name: "lookup",
      description: "Look up a city's weather.",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    });
    expect(second!.messages.at(-1)).toMatchObject({
      role: "tool",
      content: JSON.stringify({ city: "Oslo", temp: 20 }),
    });
  });

  test("without maxSteps the run is a single model turn", async () => {
    const adapter = new FakeTextAdapter([
      { toolCalls: [{ name: "lookup", input: { city: "Oslo" } }] },
      { text: "never asked" },
    ]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    await generateText(textRequest({ tools: { lookup } as unknown as AgentTools }));

    expect(adapter.requests).toHaveLength(1);
  });

  test("a tool with no execute stops the run at its call", async () => {
    const adapter = new FakeTextAdapter([
      { toolCalls: [{ name: "askHuman", input: { question: "Which city?" } }] },
      { text: "never asked" },
    ]);
    const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

    const result = await generateText(
      textRequest({
        tools: {
          askHuman: {
            description: "Ask the user.",
            inputSchema: z.object({ question: z.string() }),
          },
        } as unknown as AgentTools,
        maxSteps: 5,
      }),
    );

    expect(adapter.requests).toHaveLength(1);
    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: "askHuman", input: { question: "Which city?" } }),
    ]);
  });
});

// ─── streamText ───

describe("createTanStackAiExecutors — streamText", () => {
  test("hands every delta to onChunk and returns the accumulated text", async () => {
    const adapter = new FakeTextAdapter([{ text: "abcdefgh" }]);
    const { streamText } = createTanStackAiExecutors({ models: { quick: adapter } });
    const chunks: string[] = [];

    const result = await streamText(textRequest(), { onChunk: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["abcd", "efgh"]);
    expect(result.result).toBe("abcdefgh");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  });

  test("refuses a structured request", async () => {
    const { streamText } = createTanStackAiExecutors({
      models: { quick: new FakeTextAdapter([]) },
    });
    await expect(
      streamText(textRequest({ outputSchema: z.object({ title: z.string() }) })),
    ).rejects.toThrow("must be routed to generateText");
  });
});

// ─── decide ───

describe("createTanStackAiExecutors — decide", () => {
  test("offers one tool per event and returns the chosen event", async () => {
    const adapter = new FakeTextAdapter([
      { toolCalls: [{ name: "approve", input: { note: "LGTM", type: "REJECT" } }] },
    ]);
    const { decide } = createTanStackAiExecutors({ models: { quick: adapter } });

    const result = await decide(decisionRequest());

    // The event's own type wins over a stray `type` in the tool input.
    expect(result.event).toEqual({ note: "LGTM", type: "APPROVE" });
    expect(result.finishReason).toBe("tool-calls");
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["approve", "reject"]);
  });

  test("forces a tool call through the provider's modelOptions", async () => {
    const adapter = new FakeTextAdapter([{ toolCalls: [{ name: "reject" }] }], "openai");
    const { decide } = createTanStackAiExecutors({ models: { quick: adapter } });

    await decide(decisionRequest({ temperature: 0 }));

    expect(adapter.requests[0]!.modelOptions).toEqual({ tool_choice: "required", temperature: 0 });
  });

  test("a model that answers in text instead of a tool call throws", async () => {
    const adapter = new FakeTextAdapter([{ text: "I approve." }]);
    const { decide } = createTanStackAiExecutors({ models: { quick: adapter } });

    await expect(decide(decisionRequest())).rejects.toThrow("did not call an event tool");
  });

  test("failed attempts are appended as user messages", () => {
    const { messages } = toDecisionMessages(
      decisionRequest({
        attempts: [{ error: "bad input", event: { type: "APPROVE" } }],
      } as unknown as Partial<AgentDecisionRequest>),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Approve or reject?" });
    expect(messages[1]!.role).toBe("user");
  });
});

// ─── Mapping ───

describe("toTanStackAiMessages", () => {
  test("system messages become system prompts; tool calls and results keep their ids", () => {
    const mapped = toTanStackAiMessages({
      system: "Base.",
      messages: [
        { role: "system", content: "Extra." },
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { city: "Oslo" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "lookup",
              output: { type: "json", value: { temp: 20 } },
            },
          ],
        },
      ],
    } as Parameters<typeof toTanStackAiMessages>[0]);

    expect(mapped.systemPrompts).toEqual(["Base.", "Extra."]);
    expect(mapped.messages).toEqual([
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "lookup", arguments: JSON.stringify({ city: "Oslo" }) },
          },
        ],
      },
      { role: "tool", toolCallId: "c1", content: JSON.stringify({ temp: 20 }) },
    ]);
  });

  test("image parts become url or base64 data sources", () => {
    const { messages } = toTanStackAiMessages({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: new URL("https://example.com/a.png") },
            { type: "image", image: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    } as Parameters<typeof toTanStackAiMessages>[0]);

    expect(messages[0]!.content).toEqual([
      { type: "image", source: { type: "url", value: "https://example.com/a.png" } },
      { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
    ]);
  });
});

describe("toTanStackAiModelOptions", () => {
  const request = {
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    maxOutputTokens: 100,
    seed: 7,
    stopSequences: ["END"],
    toolChoice: { type: "tool" as const, name: "lookup" },
  };

  test("openai: Responses API keys; no top_k, seed, or stop", () => {
    expect(toTanStackAiModelOptions({ name: "openai" }, request)).toEqual({
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 100,
      tool_choice: { type: "function", name: "lookup" },
    });
  });

  test("anthropic: Messages API keys; no seed", () => {
    expect(toTanStackAiModelOptions({ name: "anthropic" }, request)).toEqual({
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 100,
      stop_sequences: ["END"],
      tool_choice: { type: "tool", name: "lookup" },
    });
  });

  test("gemini: generation config keys and a function-calling config", () => {
    expect(toTanStackAiModelOptions({ name: "gemini" }, request)).toEqual({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 100,
      seed: 7,
      stopSequences: ["END"],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
    });
  });

  test("an unknown provider gets nothing; unset keys are omitted", () => {
    expect(toTanStackAiModelOptions({ name: "ollama" }, request)).toEqual({});
    expect(toTanStackAiModelOptions({ name: "openai" }, {})).toEqual({});
  });
});

describe("settings precedence", () => {
  test("host settings, then the model entry's, then the request's own settings", async () => {
    const adapter = new FakeTextAdapter([{ text: "ok" }], "openai");
    const { generateText } = createTanStackAiExecutors({
      models: {
        quick: {
          adapter,
          settings: { modelOptions: { reasoning: { effort: "high" }, temperature: 0.5 } },
        },
      },
      settings: (request) => ({
        metadata: { request: request.name },
        modelOptions: { temperature: 1, store: false },
      }),
    });

    await generateText(textRequest({ name: "draft", temperature: 0 }));

    expect(adapter.requests[0]!.modelOptions).toEqual({
      store: false,
      reasoning: { effort: "high" },
      temperature: 0,
    });
    expect(adapter.requests[0]!.metadata).toEqual({ request: "draft" });
  });
});

// ─── With the runtime ───

describe("createTanStackAiExecutors with createAgentRuntime", () => {
  test("a machine's generateText runs through TanStack AI and its usage is aggregated", async () => {
    const adapter = new FakeTextAdapter([{ text: "hello" }]);
    const models = { quick: adapter };
    const agent = setupAgent({ context: z.object({}), input: z.object({}), models });
    const machine = agent.createMachine({
      context: ({ input }) => input,
      initial: "writing",
      states: {
        writing: {
          invoke: {
            src: "agent.generateText",
            input: { model: "quick", prompt: "hi" },
            onDone: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    });

    const result = await runToQuiescence(
      createAgentRuntime(machine, { executors: createTanStackAiExecutors({ models }) }),
      { input: {} },
    );

    expect(result.status).toBe("done");
    expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  });
});
