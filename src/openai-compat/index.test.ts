import { describe, expect, test } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { AgentDecisionRequest } from "../decision.js";
import type { AgentTextRequest } from "../text-logic.js";
import type { AgentTools } from "../types.js";
import {
  createOpenAiCompatExecutors,
  extractJsonSchema,
  toDecisionMessages,
  toOpenAiCallSettings,
  toOpenAiEventTools,
  toOpenAiMessages,
  toOpenAiTools,
  type FetchLike,
} from "./index.js";

// ─── Fake fetch: captures each request body, returns a real Response ───

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

function fakeFetch(handler: (call: CapturedCall) => Response): {
  fetch: FetchLike;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: CapturedCall = {
      url,
      body: JSON.parse(init.body) as Record<string, unknown>,
      signal: init.signal,
    };
    calls.push(call);
    return handler(call) as unknown as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, calls };
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function sseResponse(events: unknown[]): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textRequest(overrides: Partial<AgentTextRequest> = {}): AgentTextRequest & {
  tools: AgentTools;
} {
  return { model: "quick", tools: {}, ...overrides };
}

// ─── Pure request → wire mapping ───

describe("request -> wire param mapping (pure helpers)", () => {
  test("toOpenAiMessages: system + prompt lower to a system + user message", () => {
    expect(toOpenAiMessages({ system: "Be terse.", prompt: "Hi" })).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Hi" },
    ]);
  });

  test("toOpenAiMessages: messages array is mapped role-by-role, threading toolCallId", () => {
    const messages = toOpenAiMessages({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_9", output: { type: "text", value: "42" } },
          ],
        },
      ] as AgentTextRequest["messages"],
    });
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "tool", content: "42", tool_call_id: "call_9" },
    ]);
  });

  test("toOpenAiCallSettings maps maxOutputTokens -> max_tokens and prunes undefined", () => {
    expect(
      toOpenAiCallSettings({
        model: "quick",
        temperature: 0.5,
        maxOutputTokens: 100,
        topP: 0.9,
        seed: 42,
        stopSequences: ["END"],
      } as AgentTextRequest),
    ).toEqual({ temperature: 0.5, max_tokens: 100, top_p: 0.9, seed: 42, stop: ["END"] });

    expect(toOpenAiCallSettings({ model: "quick" } as AgentTextRequest)).toEqual({});
  });

  test("extractJsonSchema reads the ~standard.jsonSchema extension when present", async () => {
    const jsonSchema = await extractJsonSchema(
      z.object({ sentiment: z.enum(["positive", "negative"]) }),
    );
    expect(jsonSchema).toMatchObject({ type: "object" });
  });

  test("toOpenAiTools builds one function tool per AgentTools entry", () => {
    const tools = toOpenAiTools({
      lookup: { description: "Looks something up.", inputSchema: z.object({ query: z.string() }) },
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "function",
      function: { name: "lookup", description: "Looks something up." },
    });
    expect(tools[0]!.function.parameters).toMatchObject({ type: "object" });
  });

  test("serializes a native AI SDK tool to a wire function tool, ignoring extras", () => {
    // A raw-host adapter reads only `description`/`inputSchema`; a native
    // `tool({...})` with an execute + extra fields must serialize cleanly (no
    // crash on the extras) and never have its `execute` called here.
    let executed = false;
    const native = tool({
      description: "Multiply two numbers.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async () => {
        executed = true;
        return {};
      },
    }) as Record<string, unknown>;
    native.customExtra = { keep: true };

    const tools = toOpenAiTools({ calculate: native as never });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "function",
      function: { name: "calculate", description: "Multiply two numbers." },
    });
    expect(tools[0]!.function.parameters).toMatchObject({ type: "object" });
    expect(executed).toBe(false);
  });

  test("toOpenAiEventTools builds one function tool per candidate event", () => {
    const tools = toOpenAiEventTools([
      { type: "ASK", toolName: "send_event_ASK" },
      { type: "GUESS", toolName: "send_event_GUESS" },
    ]);
    expect(tools.map((t) => t.function.name)).toEqual(["send_event_ASK", "send_event_GUESS"]);
  });

  test("toDecisionMessages appends attempt feedback as user messages", () => {
    const messages = toDecisionMessages({
      prompt: "Pick a move.",
      events: [{ type: "ASK", toolName: "send_event_ASK" }],
      attempts: [{ failure: "unknown-event", reason: "'FOO' is not allowed." }],
    });
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("'FOO' is not allowed."),
    });
  });
});

// ─── generateText ───

describe("generateText (fake fetch, no network)", () => {
  test("plain text: posts to {baseUrl}/chat/completions and returns content", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
        usage: { total_tokens: 3 },
      }),
    );
    const { generateText } = createOpenAiCompatExecutors({
      baseUrl: "https://api.groq.com/openai/v1/",
      apiKey: "sk-test",
      fetch,
      models: { quick: "llama-3.3-70b" },
    });

    const result = await generateText(
      textRequest({ system: "Be nice.", prompt: "Hi", maxOutputTokens: 50 }),
    );

    expect(result.output).toBe("hello world");
    expect(result).toMatchObject({ finishReason: "stop", usage: { total_tokens: 3 } });
    // No trailing double slash; model ref resolved through the map.
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]!.body).toMatchObject({
      model: "llama-3.3-70b",
      max_tokens: 50,
      messages: [
        { role: "system", content: "Be nice." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(calls[0]!.body).not.toHaveProperty("response_format");
  });

  test("structured output: sends the { result } envelope schema and unwraps the reply", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        // The model replies with the { result } envelope the wire schema asks for.
        choices: [{ message: { content: JSON.stringify({ result: { sentiment: "negative" } }) } }],
      }),
    );
    const { generateText } = createOpenAiCompatExecutors({
      baseUrl: "http://localhost:11434/v1",
      fetch,
    });

    const result = await generateText(
      textRequest({
        model: "mistral",
        prompt: "Classify.",
        outputSchema: z.object({ sentiment: z.enum(["positive", "negative"]) }),
      }),
    );

    // Transparent unwrap: the machine sees the declared schema value.
    expect(result.output).toEqual({ sentiment: "negative" });
    // Every structured request is enveloped, even an object schema.
    const responseFormat = calls[0]!.body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
    };
    expect(responseFormat).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "output",
        strict: false,
        schema: { type: "object", required: ["result"] },
      },
    });
    expect(responseFormat.json_schema.schema).toHaveProperty("properties.result");
    // No reasoning property without opt-in.
    expect(JSON.stringify(responseFormat.json_schema.schema)).not.toContain("reasoning");
    // model ref passes through unchanged when not in a models map.
    expect(calls[0]!.body.model).toBe("mistral");
  });

  test("bare union outputSchema: enveloped uniformly and unwrapped", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ result: { kind: "a", a: 1 } }) } }],
      }),
    );
    const { generateText } = createOpenAiCompatExecutors({
      baseUrl: "http://localhost:11434/v1",
      fetch,
    });

    const union = z.union([
      z.object({ kind: z.literal("a"), a: z.number() }),
      z.object({ kind: z.literal("b"), b: z.string() }),
    ]);
    const result = await generateText(textRequest({ model: "mistral", outputSchema: union }));

    // Transparent unwrap: the user gets the bare union value, not the { result } wrapper.
    expect(result.output).toEqual({ kind: "a", a: 1 });
    // The wire schema is the object envelope, not a bare anyOf.
    const responseFormat = calls[0]!.body.response_format as {
      json_schema: { schema: Record<string, unknown> };
    };
    expect(responseFormat.json_schema.schema).toMatchObject({
      type: "object",
      required: ["result"],
    });
    expect(responseFormat.json_schema.schema).toHaveProperty("properties.result");
  });

  test("reasoning opt-in: advertises a reasoning property and surfaces it on the raw result", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reasoning: "leans harsh",
                result: { sentiment: "negative" },
              }),
            },
          },
        ],
      }),
    );
    const { generateText } = createOpenAiCompatExecutors({
      baseUrl: "http://localhost:11434/v1",
      fetch,
    });

    const result = await generateText(
      textRequest({
        model: "mistral",
        prompt: "Classify.",
        outputSchema: z.object({ sentiment: z.enum(["positive", "negative"]) }),
        reasoning: true,
      }),
    );

    // Output is the declared schema value; reasoning is surfaced on the raw result only.
    expect(result.output).toEqual({ sentiment: "negative" });
    expect((result as { reasoning?: unknown }).reasoning).toBe("leans harsh");
    const responseFormat = calls[0]!.body.response_format as {
      json_schema: { schema: Record<string, unknown> };
    };
    expect(responseFormat.json_schema.schema).toHaveProperty("properties.reasoning");
  });

  test("populated tool set: converts the tools onto the wire body (no local loop)", async () => {
    // openai-compat has no multi-step tool loop, so it does not run `execute` —
    // it only advertises the tools to the model. This pins the seam that DOES
    // exist: a request carrying a real tool set is serialized to wire function
    // tools (name + description + JSON-Schema parameters).
    let executed = false;
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    const { generateText } = createOpenAiCompatExecutors({
      baseUrl: "http://x/v1",
      fetch,
      models: { quick: "some-model" },
    });

    const result = await generateText(
      textRequest({
        prompt: "What is 42 times 17?",
        tools: {
          calculate: {
            description: "Multiply two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async () => {
              executed = true;
              return { product: 714 };
            },
          },
        },
      }),
    );

    expect(result.output).toBe("ok");
    // No local tool loop: execute is never called by this adapter.
    expect(executed).toBe(false);
    // Schema conversion: one wire function tool with converted parameters.
    expect(calls[0]!.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "calculate",
          description: "Multiply two numbers.",
          parameters: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              a: expect.objectContaining({ type: "number" }),
              b: expect.objectContaining({ type: "number" }),
            }),
          }),
        },
      },
    ]);
  });

  test("throws on non-2xx, naming the status and body snippet", async () => {
    const { fetch } = fakeFetch(
      () => new Response("upstream boom", { status: 500, statusText: "Server Error" }),
    );
    const { generateText } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    await expect(generateText(textRequest({ prompt: "hi" }))).rejects.toThrow(
      /500 Server Error.*upstream boom/s,
    );
  });
});

// ─── streamText ───

describe("streamText (SSE over fake fetch)", () => {
  test("forwards deltas to onChunk and resolves with the accumulated text", async () => {
    const parts = ["Why", " did", " the", " machine cross the road?"];
    const { fetch, calls } = fakeFetch(() =>
      sseResponse(parts.map((content) => ({ choices: [{ delta: { content } }] }))),
    );
    const { streamText } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    const seen: string[] = [];
    const result = await streamText(textRequest({ prompt: "joke" }), {
      onChunk: (c) => seen.push(c),
    });

    expect(seen).toEqual(parts);
    expect(result.output).toBe(parts.join(""));
    expect(calls[0]!.body.stream).toBe(true);
  });

  test("throws a named error on malformed SSE JSON", async () => {
    const { fetch } = fakeFetch(
      () => new Response("data: {not json}\n\ndata: [DONE]\n\n", { status: 200 }),
    );
    const { streamText } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    await expect(streamText(textRequest({ name: "tellJoke", prompt: "joke" }))).rejects.toThrow(
      /streamText 'tellJoke' — malformed SSE JSON/,
    );
  });
});

// ─── decide ───

function decisionRequest(overrides: Partial<AgentDecisionRequest> = {}): AgentDecisionRequest {
  return {
    kind: "decision",
    id: "d1",
    model: "quick",
    prompt: "Pick one.",
    events: [
      { type: "ASK", toolName: "send_event_ASK" },
      { type: "GUESS", toolName: "send_event_GUESS" },
    ],
    attempts: [],
    ...overrides,
  };
}

describe("decide (tool_choice required, over fake fetch)", () => {
  test("round-trips a forced tool call back to { event }", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "send_event_GUESS",
                    arguments: JSON.stringify({ guess: "a cat" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const { decide } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    const result = await decide(
      decisionRequest({ maxOutputTokens: 64 } as Partial<AgentDecisionRequest>),
    );

    expect(result.event).toEqual({ type: "GUESS", guess: "a cat" });
    expect(calls[0]!.body.tool_choice).toBe("required");
    expect(calls[0]!.body.max_tokens).toBe(64);
    expect((calls[0]!.body.tools as unknown[]).length).toBe(2);
  });

  test("renders prior attempts into the request messages", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                { type: "function", function: { name: "send_event_ASK", arguments: "" } },
              ],
            },
          },
        ],
      }),
    );
    const { decide } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    await decide(
      decisionRequest({
        attempts: [{ failure: "unknown-event", reason: "'FOO' is not allowed." }],
      }),
    );

    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("'FOO' is not allowed."),
    });
  });

  test("throws when the model returns no tool call", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: "nope" } }] }),
    );
    const { decide } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    await expect(decide(decisionRequest())).rejects.toThrow(/did not call an event tool/);
  });

  test("throws when the model calls an unknown tool", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                { type: "function", function: { name: "send_event_BOGUS", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    );
    const { decide } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    await expect(decide(decisionRequest())).rejects.toThrow(/unknown tool 'send_event_BOGUS'/);
  });

  test("the event's own type always wins over a `type` field in the tool arguments", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: "send_event_GUESS",
                    // Stray `type` in the parsed arguments must not override the event type.
                    arguments: JSON.stringify({ type: "WRONG", guess: "a cat" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const { decide } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    const result = await decide(decisionRequest());
    expect(result.event).toEqual({ type: "GUESS", guess: "a cat" });
  });

  test("forwards request.signal to fetch and rejects when it is aborted", async () => {
    // fetch that honors the abort signal, like the real one.
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    const { decide } = createOpenAiCompatExecutors({ baseUrl: "http://x/v1", fetch });

    const controller = new AbortController();
    controller.abort();
    await expect(
      decide(decisionRequest({ signal: controller.signal } as Partial<AgentDecisionRequest>)),
    ).rejects.toThrow(/Aborted/);
  });
});
