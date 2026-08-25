import { describe, expect, test } from "vitest";
import { z } from "zod";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

// The language-model stream-part type, derived from the mock's `doStream`
// result rather than importing `@ai-sdk/provider` directly (not a direct dep).
type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"];
type MockStreamResult = Extract<MockDoStream, { stream: unknown }>;
type LanguageModelStreamPart = MockStreamResult extends { stream: ReadableStream<infer P> }
  ? P
  : never;
import { tool } from "ai";
import type { AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type { AgentTools } from "../types.js";
import { createAiSdkExecutors, defineModels } from "./index.js";
import {
  extractFirstJsonValue,
  isStructuredOutputRequest,
  toAiSdkCallSettings,
  toAiSdkEventTools,
  toAiSdkToolChoice,
  toAiSdkTools,
  toDecisionMessages,
} from "./mappers.js";
import { runAgent, setupAgent } from "../index.js";
import type { AiSdkModelMap } from "./index.js";

describe("defineModels", () => {
  test("returns the map unchanged and pins a nameable, key-preserving type", () => {
    const model = new MockLanguageModelV3({});
    const models = defineModels({ quick: model, deep: model });

    // Identity at runtime.
    expect(models).toEqual({ quick: model, deep: model });

    // Type-level: the return type is the nameable `AiSdkModelMap<'quick' | 'deep'>`
    // — no TS2742 when the const is exported (examples/joke exercises that export
    // case under the examples typecheck). Assign both ways to pin the exact type.
    const asMap: AiSdkModelMap<"quick" | "deep"> = models;
    const roundTrip: typeof models = asMap;
    void roundTrip;

    // Key set is preserved for model-ref inference at the call site.
    createAiSdkExecutors({ models });

    // @ts-expect-error — 'nope' is not one of the declared model keys.
    void models.nope;
  });
});

describe("createAiSdkExecutors with core runAgent", () => {
  const response = {
    content: [{ type: "text" as const, text: "hello" }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };

  test("core runAgent runs a machine with AI SDK executors", async () => {
    const models = defineModels({ quick: new MockLanguageModelV3({ doGenerate: response }) });
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

    await expect(
      runAgent(machine, { input: {}, executors: createAiSdkExecutors({ models }) }),
    ).resolves.toMatchObject({ status: "done" });
  });

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
    const models = defineModels({ quick: new MockLanguageModelV3({ doGenerate: usageResponse }) });
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

    const result = await runAgent(machine, {
      input: {},
      executors: createAiSdkExecutors({ models }),
    });

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
      model: "openai/gpt-5.4-mini",
      messages,
    });
    expect(settings.messages).toBe(messages as never);
    expect(settings).not.toHaveProperty("prompt");
  });

  test("falls back to prompt when messages are absent", () => {
    const settings: Record<string, unknown> = toAiSdkCallSettings({
      model: "openai/gpt-5.4-mini",
      prompt: "hello",
    });
    expect(settings.prompt).toBe("hello");
    expect(settings).not.toHaveProperty("messages");
  });

  test("maps model params and toolChoice", () => {
    const settings = toAiSdkCallSettings({
      model: "openai/gpt-5.4-mini",
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
      model: "openai/gpt-5.4-mini",
      prompt: "hi",
      tools: { lookup: { description: "Look something up." } },
    });
    expect(settings.tools).toHaveProperty("lookup");
  });

  test("omits tools when request has none", () => {
    const settings = toAiSdkCallSettings({ model: "openai/gpt-5.4-mini", prompt: "hi" });
    expect(settings.tools).toBeUndefined();
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

    expect(result.output).toBe("hello");
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
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
    expect(result.output).toBe("done");
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
      metadata: { maxSteps: 5 },
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
    expect(result.output).toBe("42 times 17 is 714.");
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

    expect(result.output).toEqual({ ok: true });
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
    expect(result.output).toEqual({ kind: "a", a: 1 });
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
    expect(result.output).toEqual({ ok: true });
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
    expect(result.output).toBe("done");
  });

  test("metadata.maxSteps still works as a fallback for pre-typed-field requests", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: simulateReadableStream({
            chunks: calls < 2 ? toolCallStreamChunks(`call-${calls}`) : finalTextStreamChunks,
          }),
        };
      },
    });
    const { streamText } = createAiSdkExecutors({ models: { m: model } });

    const result = await streamText({
      model: "m",
      prompt: "hi",
      metadata: { maxSteps: 5 },
      tools: pingTool,
    });

    expect(calls).toBe(2);
    expect(result.output).toBe("done");
  });

  test("the typed maxSteps wins over metadata.maxSteps", async () => {
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

    // The typed field allows the loop; the stale metadata value (1) is ignored.
    const result = await streamText({
      model: "m",
      prompt: "hi",
      maxSteps: 5,
      metadata: { maxSteps: 1 },
      tools: pingTool,
    });

    expect(calls).toBe(3);
    expect(result.output).toBe("done");
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

    expect(result.output).toEqual({ answer: "first" });
  });

  test("generateText retries once when the output is unrepairable", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return {
          content: [
            {
              type: "text" as const,
              text: calls === 1 ? "not json at all" : '{"result":{"answer":"ok"}}',
            },
          ],
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
      outputSchema: answerSchema,
      tools: {},
    });

    expect(calls).toBe(2);
    expect(result.output).toEqual({ answer: "ok" });
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

  test("generateText surfaces the error when the retry also fails", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return {
          content: [{ type: "text" as const, text: "never json" }],
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
    expect(calls).toBe(2);
  });
});
