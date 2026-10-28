import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

// The language-model stream-part type, derived from the mock's `doStream`
// result rather than importing `@ai-sdk/provider` directly (not a direct dep).
type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"];
type MockStreamResult = Extract<MockDoStream, { stream: unknown }>;
type LanguageModelStreamPart = MockStreamResult extends { stream: ReadableStream<infer P> }
  ? P
  : never;
import { tool, type Experimental_DecisionModel } from "ai";
import {
  AgentDecisionExhaustedError,
  resolveDecision,
  type AgentDecisionRequest,
} from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type { AgentTools } from "../types.js";
import { createAiSdkExecutors, parseModelRef } from "./index.js";
import {
  extractFirstJsonValue,
  isStructuredOutputRequest,
  toAiSdkCallSettings,
  toAiSdkEventTools,
  toAiSdkToolChoice,
  toAiSdkTools,
  toDecisionMessages,
} from "./mappers.js";
import { AgentTruncatedError, createAgentRuntime, runToQuiescence, setupAgent } from "../index.js";
import type { AiSdkExecutors, AiSdkModelMap } from "./index.js";

describe("createAiSdkExecutors with core runAgent", () => {
  test("the adapter's LanguageModelUsage lands in the run result's aggregated usage", async () => {
    const usageResponse = {
      content: [{ type: "text" as const, text: "hello" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 7, noCache: 5, cacheRead: 2, cacheWrite: 0 },
        outputTokens: { total: 3, text: 2, reasoning: 1 },
      },
      warnings: [],
    };
    const models = { quick: new MockLanguageModelV3({ doGenerate: usageResponse }) };
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
      createAgentRuntime(machine, {
        executors: createAiSdkExecutors({ models }),
      }),
      {
        input: {},
      },
    );

    expect(result.status).toBe("done");
    // LanguageModelUsage -> AgentUsage: the flat token fields are folded in,
    // plus the run's own modelCalls count.
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      reasoningTokens: 1,
      cachedInputTokens: 2,
      modelCalls: 1,
    });
  });
});

describe("toAiSdkTools", () => {
  test("converts agent tool descriptors to AI SDK tools", () => {
    const inputSchema = z.object({ target: z.string() });
    const tools = toAiSdkTools({
      send_event_ATTACK: {
        description: "Attack a target.",
        inputSchema,
        execute: async (input) => ({ type: "ATTACK", ...(input as object) }),
      },
    });

    expect(tools.send_event_ATTACK).toEqual(
      expect.objectContaining({
        description: "Attack a target.",
        inputSchema,
        execute: expect.any(Function),
      }),
    );
  });

  test("passes a native AI SDK tool through unchanged, preserving extras", () => {
    // A genuine `tool({...})` already carries its own Standard Schema
    // `inputSchema`, so the adapter must hand the SAME object to the SDK — its
    // typing/validation/execute(input, options) behavior applies untouched, and
    // any extra field (here a custom `providerOptions`-style marker) survives.
    const native = tool({
      description: "Multiply two numbers.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ product: a * b }),
    }) as Record<string, unknown>;
    native.customExtra = { keep: true };

    const tools = toAiSdkTools({ calculate: native as never });

    // Identity pass-through: the very same object reference reaches the SDK.
    expect(tools.calculate).toBe(native);
    // The extra field rode along untouched.
    expect((tools.calculate as Record<string, unknown>).customExtra).toEqual({ keep: true });
  });

  test("a provider-defined tool passes through with its id (openai.tools.webSearch())", () => {
    const webSearch = {
      type: "provider",
      id: "openai.web_search",
      args: {},
      inputSchema: () => ({}),
    };
    const tools = toAiSdkTools({ web_search: webSearch as never });
    expect(tools.web_search).toBe(webSearch);
  });

  test("a native AI SDK tool assigns into an AgentTools map with no cast (type test)", () => {
    // Compile-time proof of §2: a real `ai` `tool({...})` with a concrete
    // inputSchema and an (input, options) execute is structurally an AgentTool.
    const tools: AgentTools = {
      calculate: tool({
        description: "Multiply two numbers.",
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ a, b }, options) => ({ product: a * b, id: options.toolCallId }),
      }),
    };

    expect(tools.calculate).toBeDefined();
  });
});

describe("isStructuredOutputRequest", () => {
  test("is true for an object-shaped outputSchema", () => {
    expect(isStructuredOutputRequest({ outputSchema: z.object({ ok: z.boolean() }) })).toBe(true);
  });

  test("is false with no outputSchema", () => {
    expect(isStructuredOutputRequest({})).toBe(false);
  });

  test("is false for a non-object outputSchema", () => {
    expect(isStructuredOutputRequest({ outputSchema: z.string() })).toBe(false);
  });

  test("is true for union and array outputSchemas (no top-level type)", () => {
    const union = z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]);
    const discriminated = z.discriminatedUnion("tool", [
      z.object({ tool: z.literal("x"), n: z.number() }),
      z.object({ tool: z.literal("y"), s: z.string() }),
    ]);
    expect(isStructuredOutputRequest({ outputSchema: union })).toBe(true);
    expect(isStructuredOutputRequest({ outputSchema: discriminated })).toBe(true);
    expect(isStructuredOutputRequest({ outputSchema: z.array(z.object({ a: z.string() })) })).toBe(
      true,
    );
  });
});

describe("toAiSdkToolChoice", () => {
  test("maps a named tool choice to AI SDK shape", () => {
    expect(toAiSdkToolChoice({ type: "tool", name: "send_event_ATTACK" })).toEqual({
      type: "tool",
      toolName: "send_event_ATTACK",
    });
  });

  test("passes through string choices unchanged", () => {
    expect(toAiSdkToolChoice("required")).toBe("required");
    expect(toAiSdkToolChoice(undefined)).toBeUndefined();
  });
});

describe("toAiSdkCallSettings", () => {
  test("uses messages when present (identity mapping)", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const settings: Record<string, unknown> = toAiSdkCallSettings({
      model: "openai/gpt-6-luna",
      messages,
    });
    expect(settings.messages).toBe(messages as never);
    expect(settings).not.toHaveProperty("prompt");
  });

  test("falls back to prompt when messages are absent", () => {
    const settings: Record<string, unknown> = toAiSdkCallSettings({
      model: "openai/gpt-6-luna",
      prompt: "hello",
    });
    expect(settings.prompt).toBe("hello");
    expect(settings).not.toHaveProperty("messages");
  });

  test("maps model params and toolChoice", () => {
    const settings = toAiSdkCallSettings({
      model: "openai/gpt-6-luna",
      prompt: "hi",
      temperature: 0.2,
      maxOutputTokens: 100,
      topP: 0.9,
      topK: 40,
      seed: 7,
      stopSequences: ["STOP"],
      toolChoice: { type: "tool", name: "send_event_ATTACK" },
    });

    expect(settings.temperature).toBe(0.2);
    expect(settings.maxOutputTokens).toBe(100);
    expect(settings.topP).toBe(0.9);
    expect(settings.topK).toBe(40);
    expect(settings.seed).toBe(7);
    expect(settings.stopSequences).toEqual(["STOP"]);
    expect(settings.toolChoice).toEqual({ type: "tool", toolName: "send_event_ATTACK" });
  });

  test("builds AI SDK tools when request tools are present", () => {
    const settings = toAiSdkCallSettings({
      model: "openai/gpt-6-luna",
      prompt: "hi",
      tools: { lookup: { description: "Look something up." } },
    });
    expect(settings.tools).toHaveProperty("lookup");
  });

  test("omits tools when request has none", () => {
    const settings = toAiSdkCallSettings({ model: "openai/gpt-6-luna", prompt: "hi" });
    expect(settings.tools).toBeUndefined();
  });
});

describe("createAiSdkExecutors — decide with the `{}` event shorthand", () => {
  test("an event declared as `{}` converts to an empty-object JSON Schema", async () => {
    let inputSchema: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const approve = options.tools?.find((t) => t.name === "send_event_APPROVE");
        inputSchema = approve?.type === "function" ? approve.inputSchema : undefined;
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "send_event_APPROVE",
              input: JSON.stringify({}),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const models = { m: model };
    const machine = setupAgent({
      context: z.object({}),
      events: { APPROVE: {}, REJECT: z.object({ reason: z.string() }) },
      models,
    }).createMachine({
      context: {},
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: {
              model: "m",
              prompt: "Approve?",
              allowedEvents: ["APPROVE", "REJECT"] as const,
            },
          },
          on: { APPROVE: { target: "approved" }, REJECT: { target: "rejected" } },
        },
        approved: { type: "final" },
        rejected: { type: "final" },
      },
    });

    const result = await runToQuiescence(
      createAgentRuntime(machine, { executors: createAiSdkExecutors({ models }) }),
    );

    if (result.status === "error") throw result.error;
    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("approved");
    expect(inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});

describe("toAiSdkEventTools", () => {
  test("builds one tool per event with a permissive fallback schema", () => {
    const events: AgentEventDescriptor[] = [
      {
        type: "ATTACK",
        toolName: "send_event_ATTACK",
        inputSchema: z.object({ target: z.string() }),
      },
      { type: "FLEE", toolName: "send_event_FLEE" },
    ];
    const tools = toAiSdkEventTools(events);

    expect(Object.keys(tools)).toEqual(["send_event_ATTACK", "send_event_FLEE"]);
    expect(tools.send_event_ATTACK).toEqual(
      expect.objectContaining({
        description: "Choose the 'ATTACK' move.",
        inputSchema: events[0]!.inputSchema,
      }),
    );
    // Fallback schema is present (permissive) when the event has none.
    expect(tools.send_event_FLEE!.inputSchema).toBeDefined();
  });
});

describe("toDecisionMessages", () => {
  const events: AgentEventDescriptor[] = [
    { type: "ATTACK", toolName: "send_event_ATTACK" },
    { type: "FLEE", toolName: "send_event_FLEE" },
  ];

  test("returns undefined with no messages and no attempts", () => {
    const request: Pick<AgentDecisionRequest, "messages" | "events" | "attempts"> = {
      events,
      attempts: [],
    };
    expect(toDecisionMessages(request)).toBeUndefined();
  });

  test("passes messages through unchanged when there are no attempts", () => {
    const messages = [{ role: "user" as const, content: "choose" }];
    const request: Pick<AgentDecisionRequest, "messages" | "events" | "attempts"> = {
      messages,
      events,
      attempts: [],
    };
    expect(toDecisionMessages(request)).toEqual(messages);
  });

  test("a prompt-authored decision keeps its prompt when attempts lower it to messages", () => {
    const request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts"> = {
      prompt: "Pick the best move.",
      events,
      attempts: [
        { event: { type: "HEAL" }, failure: "unknown-event", reason: "'HEAL' is not allowed." },
      ],
    };

    const messages = toDecisionMessages(request);
    expect(messages).toHaveLength(2);
    expect(messages![0]).toEqual({ role: "user", content: "Pick the best move." });
    expect(messages![1]!.role).toBe("user");
  });

  test("appends a user message per failed attempt describing the failure and choices", () => {
    const request: Pick<AgentDecisionRequest, "messages" | "events" | "attempts"> = {
      events,
      attempts: [
        { event: { type: "HEAL" }, failure: "unknown-event", reason: "'HEAL' is not allowed." },
      ],
    };

    const messages = toDecisionMessages(request);
    expect(messages).toHaveLength(1);
    expect(messages![0]).toEqual({
      role: "user",
      content:
        "Your previous choice failed: 'HEAL' is not allowed.. Choose again from: ATTACK, FLEE",
    });
  });

  test("renders multiple attempts as multiple appended messages, in order", () => {
    const request: Pick<AgentDecisionRequest, "messages" | "events" | "attempts"> = {
      messages: [{ role: "user", content: "go" }],
      events,
      attempts: [
        { failure: "unknown-event", reason: "first failure" },
        { failure: "invalid-payload", reason: "second failure" },
      ],
    };

    const messages = toDecisionMessages(request);
    expect(messages).toHaveLength(3);
    expect(messages![1]!.content).toContain("first failure");
    expect(messages![2]!.content).toContain("second failure");
  });
});

describe("onResult metadata enrichment", () => {
  test("generateText returns usage/finishReason/toolCalls alongside output", async () => {
    const { MockLanguageModelV3 } = await import("ai/test");
    const { createAiSdkExecutors } = await import("./index.js");

    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "hello" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      },
    });

    const executors = createAiSdkExecutors({ models: { m: model } });
    const result = await executors.generateText({ model: "m", prompt: "hi", tools: {} });

    expect(result.result).toBe("hello");
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
    expect(result.messages).toHaveLength(1);
    expect(result.raw).toBeDefined();
  });

  test("decide returns usage/finishReason alongside the chosen event", async () => {
    const { MockLanguageModelV3 } = await import("ai/test");
    const { createAiSdkExecutors } = await import("./index.js");

    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "choose_GO",
            input: JSON.stringify({}),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      },
    });

    const executors = createAiSdkExecutors({ models: { m: model } });
    const result = await executors.decide({
      kind: "decision",
      id: "d1",
      model: "m",
      prompt: "choose",
      events: [{ type: "GO", toolName: "choose_GO" }],
      attempts: [],
    });

    expect(result.event).toEqual({ type: "GO" });
    expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    expect(result.finishReason).toBe("tool-calls");
  });

  test("decide: the event's own type always wins over a `type` field in the tool input", async () => {
    const { MockLanguageModelV3 } = await import("ai/test");
    const { createAiSdkExecutors } = await import("./index.js");

    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "choose_GO",
            // Model returns a stray `type` in the tool input — it must NOT
            // override the chosen event's own type.
            input: JSON.stringify({ type: "WRONG", note: "hi" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });

    const executors = createAiSdkExecutors({ models: { m: model } });
    const result = await executors.decide({
      kind: "decision",
      id: "d1",
      model: "m",
      prompt: "choose",
      events: [{ type: "GO", toolName: "choose_GO" }],
      attempts: [],
    });

    expect(result.event).toEqual({ type: "GO", note: "hi" });
  });
});

describe("maxSteps (multi-step tool loops)", () => {
  const streamUsage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const toolCallStreamChunks = (id: string): LanguageModelStreamPart[] => [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: "ping", input: "{}" },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: streamUsage,
    },
  ];
  const finalTextStreamChunks: LanguageModelStreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "done" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: streamUsage },
  ];

  const pingTool = {
    ping: {
      description: "ping",
      inputSchema: z.object({}),
      execute: async () => "pong",
    },
  };

  test("streamText honors the typed maxSteps (loops the tool call, matching generateText)", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: simulateReadableStream({
            chunks: calls < 3 ? toolCallStreamChunks(`call-${calls}`) : finalTextStreamChunks,
          }),
        };
      },
    });
    const { streamText } = createAiSdkExecutors({ models: { m: model } });

    const result = await streamText({
      model: "m",
      prompt: "hi",
      maxSteps: 5,
      tools: pingTool,
    });

    expect(calls).toBe(3);
    expect(result.result).toBe("done");
    expect(result.modelCalls).toBe(3);
  });

  test("streamText stays single-step when maxSteps is absent (regression: was ignored)", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: simulateReadableStream({ chunks: toolCallStreamChunks(`call-${calls}`) }),
        };
      },
    });
    const { streamText } = createAiSdkExecutors({ models: { m: model } });

    await streamText({ model: "m", prompt: "hi", tools: pingTool });

    // Without maxSteps, the tool loop is not entered — exactly one model call.
    expect(calls).toBe(1);
  });

  test("generateText: populated tool set round-trips — schema-parsed input, execute invoked, result fed back, final output", async () => {
    // The dogfood #3 pins: a text request carrying a real tool set (description
    // + zod inputSchema + execute) is converted to AI SDK tools, the model's
    // raw JSON tool input is validated/parsed to the typed object handed to
    // `execute`, the tool result is fed back into the next model call, and the
    // final assistant text resolves as `output`.
    const executeInputs: unknown[] = [];
    const executeOptions: unknown[] = [];
    const secondCallMessages: unknown[] = [];
    let calls = 0;
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls++;
        if (calls === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "calculate",
                // Raw JSON string, as a provider returns it — the adapter must
                // let the AI SDK validate/parse it against `inputSchema`.
                input: JSON.stringify({ a: 42, b: 17 }),
              },
            ],
            finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
            usage,
            warnings: [],
          };
        }
        // Capture the second call's prompt to prove the tool result was fed back.
        secondCallMessages.push(...((options.prompt ?? []) as unknown[]));
        return {
          content: [{ type: "text" as const, text: "42 times 17 is 714." }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });
    const { generateText } = createAiSdkExecutors({ models: { m: model } });

    const result = await generateText({
      model: "m",
      prompt: "What is 42 times 17?",
      maxSteps: 5,
      tools: {
        // A genuine AI SDK `tool({...})` — `input` is typed from `inputSchema`
        // by the SDK, no cast. The adapter hands it to the SDK unchanged, so the
        // SDK's own validation runs and `execute` is called with (input, options).
        calculate: tool({
          description: "Multiply two numbers.",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async (input, options) => {
            executeInputs.push(input);
            executeOptions.push(options);
            const { a, b } = input;
            return { product: a * b };
          },
        }),
      },
    });

    // Schema conversion + parse: execute got the typed, parsed object (numbers),
    // not the raw JSON string.
    expect(executeInputs).toEqual([{ a: 42, b: 17 }]);
    // Native (input, options) arity: the SDK passed a second options arg
    // carrying the tool call id.
    expect(executeOptions[0]).toMatchObject({ toolCallId: "call-1" });
    // Fed back: the second model call's messages carry a tool result for the call.
    const fedBack = JSON.stringify(secondCallMessages);
    expect(fedBack).toContain("tool-result");
    expect(fedBack).toContain("714");
    // Final output resolution + loop actually ran twice.
    expect(calls).toBe(2);
    expect(result.result).toBe("42 times 17 is 714.");
  });

  const structuredUsage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };

  test("generateText: every structured request is sent as the { result } envelope and unwrapped", async () => {
    // The uniform envelope contract: an object schema (a valid root on its own)
    // is STILL enveloped as `{ result: <schema> }`, so all structured requests
    // are wire-identical. The adapter unwraps `.result` before returning, so the
    // machine validates the declared schema transparently.
    let sentResponseFormat: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        sentResponseFormat = (options as { responseFormat?: unknown }).responseFormat;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ result: { ok: true } }) }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: structuredUsage,
          warnings: [],
        };
      },
    });
    const { generateText } = createAiSdkExecutors({ models: { m: model } });

    const schema = z.object({ ok: z.boolean() });
    const result = await generateText({ model: "m", prompt: "x", outputSchema: schema, tools: {} });

    expect(result.result).toEqual({ ok: true });
    expect(result.reasoning).toBeUndefined();
    // The provider saw the enveloped schema (its json schema mentions `result`).
    expect(JSON.stringify(sentResponseFormat)).toContain("result");
  });

  test("generateText: a bare union is enveloped uniformly and unwrapped", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ result: { kind: "a", a: 1 } }) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: structuredUsage,
        warnings: [],
      }),
    });
    const { generateText } = createAiSdkExecutors({ models: { m: model } });

    const union = z.union([
      z.object({ kind: z.literal("a"), a: z.number() }),
      z.object({ kind: z.literal("b"), b: z.string() }),
    ]);
    const result = await generateText({ model: "m", prompt: "x", outputSchema: union, tools: {} });

    // Transparent unwrap: caller gets the inner union value, not { result }.
    expect(result.result).toEqual({ kind: "a", a: 1 });
  });

  test("generateText: reasoning opt-in adds a reasoning property and surfaces it on the raw result", async () => {
    let sentResponseFormat: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        sentResponseFormat = (options as { responseFormat?: unknown }).responseFormat;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ reasoning: "because true", result: { ok: true } }),
            },
          ],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: structuredUsage,
          warnings: [],
        };
      },
    });
    const { generateText } = createAiSdkExecutors({ models: { m: model } });

    const schema = z.object({ ok: z.boolean() });
    const result = await generateText({
      model: "m",
      prompt: "x",
      outputSchema: schema,
      includeReasoning: true,
      tools: {},
    });

    // Output is the declared schema value only; reasoning is a raw-result field.
    expect(result.result).toEqual({ ok: true });
    expect(result.reasoning).toBe("because true");
    // The enveloped schema advertised `reasoning` to the provider.
    expect(JSON.stringify(sentResponseFormat)).toContain("reasoning");
  });

  test("generateText: without reasoning opt-in, no reasoning property is sent", async () => {
    let sentResponseFormat: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        sentResponseFormat = (options as { responseFormat?: unknown }).responseFormat;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ result: { ok: true } }) }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: structuredUsage,
          warnings: [],
        };
      },
    });
    const { generateText } = createAiSdkExecutors({ models: { m: model } });

    await generateText({
      model: "m",
      prompt: "x",
      outputSchema: z.object({ ok: z.boolean() }),
      tools: {},
    });
    expect(JSON.stringify(sentResponseFormat)).not.toContain("reasoning");
  });

  test("generateText honors the typed maxSteps (symmetry check)", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        const finishReason = { unified: "tool-calls" as const, raw: "tool_calls" };
        const usage = {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        };
        if (calls < 3) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: `call-${calls}`,
                toolName: "ping",
                input: "{}",
              },
            ],
            finishReason,
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "done" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });
    const { generateText } = createAiSdkExecutors({ models: { m: model } });

    const result = await generateText({
      model: "m",
      prompt: "hi",
      maxSteps: 5,
      tools: pingTool,
    });

    expect(calls).toBe(3);
    expect(result.result).toBe("done");
    expect(result.modelCalls).toBe(3);
  });

  test("only the typed maxSteps controls the tool loop", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: simulateReadableStream({
            chunks: calls < 3 ? toolCallStreamChunks(`call-${calls}`) : finalTextStreamChunks,
          }),
        };
      },
    });
    const { streamText } = createAiSdkExecutors({ models: { m: model } });

    // Host metadata is transparent and cannot override agent control flow.
    const result = await streamText({
      model: "m",
      prompt: "hi",
      maxSteps: 5,
      metadata: { maxSteps: 1 },
      tools: pingTool,
    });

    expect(calls).toBe(3);
    expect(result.result).toBe("done");
    expect(result.modelCalls).toBe(3);
  });
});

describe("structured-output resilience", () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const answerSchema = z.object({ answer: z.string() });

  test("extractFirstJsonValue recovers the first of two concatenated objects", () => {
    expect(extractFirstJsonValue('{"a":1}{"b":2}')).toBe('{"a":1}');
    expect(extractFirstJsonValue('{"a":"br{ce}s and \\"quotes\\""}{"b":2}')).toBe(
      '{"a":"br{ce}s and \\"quotes\\""}',
    );
    expect(extractFirstJsonValue('[{"a":1}][{"b":2}]')).toBe('[{"a":1}]');
  });

  test("extractFirstJsonValue returns undefined when there is nothing to repair", () => {
    expect(extractFirstJsonValue('{"a":1}')).toBeUndefined();
    expect(extractFirstJsonValue("no json here")).toBeUndefined();
    expect(extractFirstJsonValue('{"a":1')).toBeUndefined();
  });

  test("generateText salvages a response of two concatenated envelopes", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "text",
            text: '{"result":{"answer":"first"}}{"result":{"answer":"second"}}',
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    });

    const { generateText } = createAiSdkExecutors({ models: { m: model } });
    const result = await generateText({
      model: "m",
      prompt: "hi",
      outputSchema: answerSchema,
      tools: {},
    });

    expect(result.result).toEqual({ answer: "first" });
  });

  test("generateText leaves unrepairable output retry policy to the AI SDK/host", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return {
          content: [
            {
              type: "text" as const,
              text: "not json at all",
            },
          ],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });

    const { generateText } = createAiSdkExecutors({ models: { m: model } });
    await expect(
      generateText({ model: "m", prompt: "hi", outputSchema: answerSchema, tools: {} }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("generateText does NOT retry a request that carries tools (side effects)", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return {
          content: [{ type: "text" as const, text: "not json at all" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });

    const { generateText } = createAiSdkExecutors({ models: { m: model } });
    await expect(
      generateText({
        model: "m",
        prompt: "hi",
        outputSchema: answerSchema,
        // A tool with an execute fn may have already run in the tool loop —
        // re-sending the request would execute it again.
        tools: { ping: async () => "pong" },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("host `settings` reach the model call, and the machine's own settings win", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.push(options as unknown as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: "ok" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });

    const { generateText } = createAiSdkExecutors({
      models: { m: model },
      // Reasoning effort is the host's call, not the machine's. `temperature`
      // is set here too, to prove the request still outranks the host.
      settings: { reasoning: "high", temperature: 0.9 },
    });

    await generateText({ model: "m", prompt: "hi", temperature: 0.1, tools: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.reasoning).toBe("high");
    expect(seen[0]!.temperature).toBe(0.1);
  });

  test("`settings` can vary per request", async () => {
    const efforts: Array<unknown> = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        efforts.push((options as unknown as { reasoning?: unknown }).reasoning);
        return {
          content: [{ type: "text" as const, text: "ok" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });

    const { generateText } = createAiSdkExecutors({
      models: { m: model },
      settings: (request) =>
        "name" in request && request.name === "review" ? { reasoning: "xhigh" } : undefined,
    });

    await generateText({ name: "review", model: "m", prompt: "hi", tools: {} });
    await generateText({ name: "draft", model: "m", prompt: "hi", tools: {} });

    expect(efforts).toEqual(["xhigh", undefined]);
  });

  test("a host setting survives a request that leaves the same key unset", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.push(options as unknown as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: "ok" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });

    const { generateText } = createAiSdkExecutors({
      models: { m: model },
      settings: { temperature: 0.9 },
    });

    // The request declares no temperature, so the mapper must not emit an
    // `undefined` that spreads over the host's value.
    await generateText({ model: "m", prompt: "hi", tools: {} });

    expect(seen[0]!.temperature).toBe(0.9);
  });

  test("a model ref can carry its own settings, and the request still outranks them", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const makeModel = () =>
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          seen.push(options as unknown as Record<string, unknown>);
          return {
            content: [{ type: "text" as const, text: "ok" }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });

    const { generateText } = createAiSdkExecutors({
      models: {
        quick: makeModel(),
        // `deep` is a persona: this ref always thinks harder.
        deep: { model: makeModel(), settings: { reasoning: "xhigh", temperature: 0.5 } },
      },
    });

    await generateText({ model: "quick", prompt: "hi", tools: {} });
    await generateText({ model: "deep", prompt: "hi", tools: {} });
    await generateText({ model: "deep", prompt: "hi", temperature: 0.1, tools: {} });

    expect(seen[0]!.reasoning).toBeUndefined();
    expect(seen[1]!.reasoning).toBe("xhigh");
    expect(seen[1]!.temperature).toBe(0.5);
    // The machine's own value wins over the ref's persona.
    expect(seen[2]!.temperature).toBe(0.1);
  });

  test("a model ref's settings outrank the host-wide `settings`", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.push(options as unknown as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: "ok" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });

    const { generateText } = createAiSdkExecutors({
      models: { deep: { model, settings: { reasoning: "xhigh" } } },
      settings: { reasoning: "low" },
    });

    await generateText({ model: "deep", prompt: "hi", tools: {} });

    expect(seen[0]!.reasoning).toBe("xhigh");
  });

  test("decide inherits host and model settings, and the decision still overrides them", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.push(options as unknown as Record<string, unknown>);
        return {
          content: [
            { type: "tool-call" as const, toolCallId: "c1", toolName: "choose_GO", input: "{}" },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });

    const { decide } = createAiSdkExecutors({
      models: { m: { model, settings: { reasoning: "xhigh", topP: 0.3 } } },
      settings: { temperature: 0.9, maxOutputTokens: 256 },
    });

    const base = {
      kind: "decision" as const,
      id: "d1",
      model: "m",
      prompt: "choose",
      events: [{ type: "GO", toolName: "choose_GO" }],
      attempts: [],
    };

    await decide(base);
    await decide({ ...base, temperature: 0.1 });

    // A decision that declares nothing still gets the host and model defaults.
    expect(seen[0]!.temperature).toBe(0.9);
    expect(seen[0]!.maxOutputTokens).toBe(256);
    expect(seen[0]!.topP).toBe(0.3);
    expect(seen[0]!.reasoning).toBe("xhigh");
    // What the decision does declare still wins.
    expect(seen[1]!.temperature).toBe(0.1);
    expect(seen[1]!.topP).toBe(0.3);
  });
});

describe("createAiSdkExecutors — truncation", () => {
  const usage = {
    inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  };
  const answerSchema = z.object({ answer: z.string() });

  test("a truncated structured request is an AgentTruncatedError", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: '{"result":{"answer":"half' }],
        finishReason: { unified: "length" as const, raw: "length" },
        usage,
        warnings: [],
      }),
    });

    const { generateText } = createAiSdkExecutors({ models: { m: model } });
    const error = await generateText({
      model: "m",
      name: "answer",
      prompt: "hi",
      outputSchema: answerSchema,
      tools: {},
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTruncatedError);
    expect(error).toMatchObject({ code: "truncated", requestName: "answer" });
  });

  test("a truncated text request keeps its text and reports finishReason 'length'", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "as far as it got" }],
        finishReason: { unified: "length" as const, raw: "length" },
        usage,
        warnings: [],
      }),
    });

    const { generateText } = createAiSdkExecutors({ models: { m: model } });
    const result = await generateText({ model: "m", name: "draft", prompt: "hi", tools: {} });

    expect(result.result).toBe("as far as it got");
    expect(result.finishReason).toBe("length");
  });
});

describe("parseModelRef", () => {
  test("splits provider/model-id refs on the first slash", () => {
    expect(parseModelRef("openai/gpt-6-luna")).toEqual({
      provider: "openai",
      modelId: "gpt-6-luna",
    });
    // Only the FIRST slash splits — model ids may contain slashes.
    expect(parseModelRef("openrouter/meta/llama-3")).toEqual({
      provider: "openrouter",
      modelId: "meta/llama-3",
    });
  });

  test("a ref without a slash has no provider", () => {
    expect(parseModelRef("quick")).toEqual({ provider: undefined, modelId: "quick" });
  });
});

describe("createAiSdkExecutors model sources", () => {
  const textResponse = {
    content: [{ type: "text" as const, text: "hello" }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
  const request = { name: "greet", model: "quick", prompt: "hi", tools: {} };

  function build() {
    const models = { quick: new MockLanguageModelV3({ doGenerate: textResponse }) };
    const agentSetup = setupAgent({ context: z.object({}), input: z.object({}), models });
    const machine = agentSetup.createMachine({
      context: ({ input }) => input,
      initial: "done",
      states: { done: { type: "final" } },
    });
    return { models, agentSetup, machine };
  }

  test("accepts the legacy { models } object", async () => {
    const { models } = build();
    const { generateText } = createAiSdkExecutors({ models });
    expect((await generateText(request)).result).toBe("hello");
  });

  test("accepts a setupAgent(...) result and reads its models", async () => {
    const { agentSetup } = build();
    const { generateText } = createAiSdkExecutors(agentSetup);
    expect((await generateText(request)).result).toBe("hello");
  });

  test("accepts a machine and reads the models registered by setupAgent", async () => {
    const { machine, models } = build();
    const { generateText } = createAiSdkExecutors(machine);
    expect((await generateText(request)).result).toBe("hello");
    expect(models.quick.doGenerateCalls).toHaveLength(1);
  });

  test("accepts a machine rebound with .provide(...)", async () => {
    const { machine } = build();
    const { generateText } = createAiSdkExecutors(machine.provide({}));
    expect((await generateText(request)).result).toBe("hello");
  });

  test("throws at construction for a wrong-shaped argument, naming what it got", () => {
    expect(() => createAiSdkExecutors({} as never)).toThrow(/got an empty object/);
    expect(() => createAiSdkExecutors({ model: "x" } as never)).toThrow(
      /got an object with keys model/,
    );
    expect(() => createAiSdkExecutors(undefined as never)).toThrow(/got undefined/);
    const bare = setupAgent({ context: z.object({}), input: z.object({}) });
    expect(() => createAiSdkExecutors(bare)).toThrow(
      /got a setupAgent\(\.\.\.\) result that declared no models/,
    );
    const bareMachine = bare.createMachine({
      context: ({ input }) => input,
      initial: "done",
      states: { done: { type: "final" } },
    });
    expect(() => createAiSdkExecutors(bareMachine)).toThrow(
      /got a machine whose setupAgent\(\.\.\.\) declared no models/,
    );
  });
});

describe("createAiSdkExecutors — decide answers that name no candidate", () => {
  type Answer = { toolName: string; input: string } | string;
  // One answer per model call, in order: a tool call, or plain text.
  function answering(...answers: Answer[]) {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const answer = answers[call++]!;
        return {
          content: [
            typeof answer === "string"
              ? { type: "text" as const, text: answer }
              : { type: "tool-call" as const, toolCallId: `call-${call}`, ...answer },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    return createAiSdkExecutors({ models: { m: model } }).decide;
  }
  const request: AgentDecisionRequest = {
    kind: "decision",
    id: "d1",
    model: "m",
    prompt: "choose",
    events: [
      {
        type: "approve",
        toolName: "send_event_approve",
        inputSchema: z.object({ note: z.string() }),
      },
      { type: "reject", toolName: "send_event_reject" },
    ],
    attempts: [],
  };
  const reject = { toolName: "send_event_reject", input: "{}" };
  async function resolveWith(...answers: Answer[]) {
    const decide = answering(...answers);
    const seen: AgentDecisionRequest[] = [];
    const event = await resolveDecision(request, {
      decide: (attempt, info) => (seen.push(attempt), decide(attempt, info)),
    });
    return { event, reasons: seen.at(-1)!.attempts.map((attempt) => attempt.reason) };
  }

  test("a text answer is retried, its usage still reported", async () => {
    const result = await answering("I approve.")(request);
    expect(result.event.type).toBe(
      "no tool was called (call exactly one of: send_event_approve, send_event_reject)",
    );
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 });

    expect(await resolveWith("I approve.", reject)).toEqual({
      event: { type: "reject" },
      reasons: [
        "'no tool was called (call exactly one of: send_event_approve, send_event_reject)' is " +
          "not among the currently allowed events: approve, reject.",
      ],
    });
  });

  test("a call to an unknown tool is retried, naming the valid tools", async () => {
    expect(await resolveWith({ toolName: "send_event_quit", input: "{}" }, reject)).toEqual({
      event: { type: "reject" },
      reasons: [
        "'tool 'send_event_quit' was not offered (valid tools: send_event_approve, " +
          "send_event_reject)' is not among the currently allowed events: approve, reject.",
      ],
    });
  });

  test("malformed tool arguments are retried with a reason that says so", async () => {
    const { event, reasons } = await resolveWith(
      { toolName: "send_event_approve", input: '{"note": "LG' },
      reject,
    );
    expect(event).toEqual({ type: "reject" });
    expect(reasons).toEqual([
      expect.stringContaining("the arguments for tool 'send_event_approve' were not valid JSON"),
    ]);
  });

  test("answers that never name a candidate exhaust the retries", async () => {
    const decide = answering("no", "no", "no");
    const error = await resolveDecision(request, { decide }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentDecisionExhaustedError);
    expect((error as AgentDecisionExhaustedError).attempts.map((a) => a.failure)).toEqual([
      "unknown-event",
      "unknown-event",
      "unknown-event",
    ]);
  });
});

describe("createAiSdkExecutors — decide over closed-choice options", () => {
  test("presents one tool with an enum of option ids and maps the chosen id back", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "choose_option",
            input: JSON.stringify({ option: "refund:20" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });

    const { decide } = createAiSdkExecutors({ models: { m: model } });
    const result = await decide({
      kind: "decision",
      id: "d1",
      model: "m",
      prompt: "choose",
      events: [
        { type: "refund", toolName: "send_event_refund" },
        { type: "escalate", toolName: "send_event_escalate" },
      ],
      options: [
        { event: { type: "refund", amount: 20 }, description: "Refund $20" },
        { event: { type: "escalate" }, description: "Hand to a person" },
      ],
      attempts: [],
    });

    const tools = model.doGenerateCalls[0]!.tools ?? [];
    expect(tools).toHaveLength(1);
    const [only] = tools as Array<{ name: string; description?: string; inputSchema: unknown }>;
    expect(only!.name).toBe("choose_option");
    expect(only!.description).toContain("refund:20: Refund $20");
    expect(only!.description).toContain("escalate: Hand to a person");
    expect(only!.inputSchema).toMatchObject({
      properties: { option: { enum: ["refund:20", "escalate"] } },
      required: ["option"],
    });
    expect(result.event).toEqual({ type: "refund", amount: 20 });
  });

  test("an id that is not offered, or another tool, is retried, not thrown", async () => {
    const calls = [
      { toolName: "choose_option", input: { option: "refund:99" } },
      { toolName: "send_event_refund", input: { amount: 20 } },
      { toolName: "choose_option", input: { option: "escalate" } },
    ];
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const { toolName, input } = calls[call++]!;
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call-${call}`,
              toolName,
              input: JSON.stringify(input),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const { decide } = createAiSdkExecutors({ models: { m: model } });
    const request: AgentDecisionRequest = {
      kind: "decision",
      id: "d1",
      model: "m",
      prompt: "choose",
      events: [
        { type: "refund", toolName: "send_event_refund" },
        { type: "escalate", toolName: "send_event_escalate" },
      ],
      options: [{ event: { type: "refund", amount: 20 } }, { event: { type: "escalate" } }],
      attempts: [],
    };
    const seen: AgentDecisionRequest[] = [];
    const event = await resolveDecision(request, {
      decide: (attempt, info) => (seen.push(attempt), decide(attempt, info)),
    });

    expect(event).toEqual({ type: "escalate" });
    expect(seen[2]!.attempts.map((attempt) => [attempt.failure, attempt.reason])).toEqual([
      [
        "unknown-event",
        `'option "refund:99" was not offered (valid ids: refund:20, escalate)' is not among ` +
          "the currently allowed events: refund, escalate.",
      ],
      [
        "unknown-event",
        `'tool 'send_event_refund' was not offered (valid ids: refund:20, escalate)' is not ` +
          "among the currently allowed events: refund, escalate.",
      ],
    ]);
  });
});

describe("createAiSdkExecutors — decision models in the models map", () => {
  type DecisionModelDouble = Extract<Experimental_DecisionModel, { doDecide: unknown }>;
  type DecideCall = Parameters<DecisionModelDouble["doDecide"]>[0];

  // Minimal doDecide double: answers `picks` (the next one per call, the last
  // repeating) to every choice question, with `share` of the probability mass on it.
  function judge(picks: string | string[], share = 0.9) {
    const calls: DecideCall[] = [];
    const model: DecisionModelDouble = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-judge",
      supportedQuestionTypes: ["choice"],
      doDecide: async (options) => {
        calls.push(options);
        const list = [picks].flat();
        const pick = list[Math.min(calls.length, list.length) - 1]!;
        const answers = Object.fromEntries(
          Object.entries(options.questions).map(([id, question]) => {
            const labels = Object.keys(question.criteria ?? {});
            const rest = labels.length > 1 ? (1 - share) / (labels.length - 1) : 0;
            return [
              id,
              {
                type: "choice" as const,
                choice: pick,
                probabilities: Object.fromEntries(
                  labels.map((label) => [label, label === pick ? share : rest]),
                ),
              },
            ];
          }),
        );
        return { answers, warnings: [], usage: { inputTokens: 3, outputTokens: 1 } };
      },
    };
    return { model, calls };
  }

  const request: AgentDecisionRequest = {
    kind: "decision",
    id: "d1",
    name: "triage",
    model: "judge",
    system: "You run a refund desk.",
    prompt: "What should the desk do?",
    input: { ticket: "Charged twice" },
    events: [
      { type: "refund", toolName: "send_event_refund" },
      { type: "escalate", toolName: "send_event_escalate" },
    ],
    options: [
      { event: { type: "refund", amount: 20 }, description: "Refund $20" },
      { event: { type: "escalate" } },
    ],
    attempts: [],
  };

  test("asks one choice question over the options and maps the label back", async () => {
    const { model, calls } = judge("refund:20");
    const { decide } = createAiSdkExecutors({ models: { judge: model } });
    const result = await decide(request);

    expect(calls).toHaveLength(1);
    const questions = Object.values(calls[0]!.questions);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      type: "choice",
      instructions: "You run a refund desk.\n\nWhat should the desk do?",
      criteria: { "refund:20": "Refund $20", escalate: '{"type":"escalate"}' },
    });
    expect(calls[0]!.state).toEqual([{ type: "json", value: { ticket: "Charged twice" } }]);
    expect(result).toMatchObject({
      event: { type: "refund", amount: 20 },
      confidence: 0.9,
      usage: { inputTokens: 3, outputTokens: 1 },
    });
  });

  test("resolveModel may return a decision model", async () => {
    const { model, calls } = judge("escalate");
    const { decide } = createAiSdkExecutors({ resolveModel: () => model });
    expect((await decide(request)).event).toEqual({ type: "escalate" });
    expect(calls).toHaveLength(1);
  });

  test("a label that is not an option is retried, naming the valid ids", async () => {
    const { model, calls } = judge(["refund:99", "escalate"]);
    const { decide } = createAiSdkExecutors({ models: { judge: model } });
    const seen: AgentDecisionRequest[] = [];
    const event = await resolveDecision(request, {
      decide: (attempt, info) => (seen.push(attempt), decide(attempt, info)),
    });

    expect(event).toEqual({ type: "escalate" });
    expect(calls).toHaveLength(2);
    expect(seen[1]!.attempts).toEqual([
      expect.objectContaining({
        failure: "unknown-event",
        reason: expect.stringContaining(
          `option "refund:99" was not offered (valid ids: refund:20, escalate)`,
        ),
      }),
    ]);
  });

  test("a retry renders the prior attempts into the question's instructions", async () => {
    const { model, calls } = judge(["refund:99", "escalate"]);
    const { decide } = createAiSdkExecutors({ models: { judge: model } });
    const seen: AgentDecisionRequest[] = [];
    await resolveDecision(request, {
      decide: (attempt, info) => (seen.push(attempt), decide(attempt, info)),
    });

    const instructionsOf = (call: DecideCall) =>
      (Object.values(call.questions)[0] as { instructions: string }).instructions;
    expect(instructionsOf(calls[0]!)).toBe("You run a refund desk.\n\nWhat should the desk do?");
    expect(instructionsOf(calls[1]!)).toContain(seen[1]!.attempts[0]!.reason);
    expect(instructionsOf(calls[1]!)).toContain("Choose again from: refund:20, escalate");
  });

  test("a request without options throws: decision models need a closed choice", async () => {
    const { model, calls } = judge("escalate");
    const { decide } = createAiSdkExecutors({ models: { judge: model } });
    await expect(decide({ ...request, options: undefined })).rejects.toThrow(
      /decision 'triage' uses decision model 'judge', which needs a closed choice: pass `payloads` on agent\.decide, or use decideNext/,
    );
    expect(calls).toHaveLength(0);
  });

  test("a text request on a decision model throws", async () => {
    const { model, calls } = judge("escalate");
    const executors = createAiSdkExecutors({ models: { judge: model } });
    const text = { kind: "text" as const, name: "reply", model: "judge", prompt: "hi", tools: {} };
    await expect(executors.generateText(text)).rejects.toThrow(
      /model 'judge' is a decision model.*text request 'reply' needs a language model/,
    );
    await expect(executors.streamText(text)).rejects.toThrow(/is a decision model/);
    expect(calls).toHaveLength(0);
  });

  test("language models in the same map keep the tool-call path", async () => {
    const { model: judgeModel, calls } = judge("escalate");
    const desk = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "choose_option",
            input: JSON.stringify({ option: "refund:20" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const { decide } = createAiSdkExecutors({ models: { desk, judge: judgeModel } });
    const result = await decide({ ...request, model: "desk" });
    expect(result.event).toEqual({ type: "refund", amount: 20 });
    expect(result).not.toHaveProperty("confidence");
    expect(desk.doGenerateCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test("types: the models map and setupAgent models accept both kinds", () => {
    const models = {
      desk: new MockLanguageModelV3(),
      deep: { model: new MockLanguageModelV3(), settings: { maxRetries: 0 } },
      judge: judge("escalate").model,
    };
    expectTypeOf(models).toExtend<AiSdkModelMap>();
    const agentSetup = setupAgent({ context: z.object({}), models });
    expectTypeOf(createAiSdkExecutors({ models })).toEqualTypeOf<AiSdkExecutors>();
    expectTypeOf(
      createAiSdkExecutors(agentSetup.createMachine({ context: {} })),
    ).toEqualTypeOf<AiSdkExecutors>();
  });
});
