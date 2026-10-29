import { describe, expect, onTestFinished, test, vi } from "vitest";
import { z } from "zod";
import { AgentTruncatedError } from "../errors.js";
import {
  AgentDecisionExhaustedError,
  resolveDecision,
  type AgentDecisionRequest,
} from "../decision.js";
import type { AgentTextRequest } from "../text-logic.js";
import type { AgentTools } from "../types.js";
import {
  createOpenAiExecutors,
  toAgentCallUsage,
  toAgentFinishReason,
  toDecisionMessages,
  toOpenAiCallSettings,
  toOpenAiEventTools,
  toOpenAiMessages,
  toOpenAiTools,
  toResponsesInput,
} from "./index.js";

// A stubbed `OpenAI` client for tool-free calls: only `chat.completions.create`
// is ever called, so the whole SDK surface reduces to one function. No network.
function stubClient(create: (params: any, options?: any) => unknown) {
  return { chat: { completions: { create } } } as never;
}

// A stubbed `OpenAI` client for calls with function tools, which go through
// `responses.create`. A Chat Completions call fails the test.
function stubResponsesClient(create: (params: any, options?: any) => unknown) {
  const chatCreate = () => {
    throw new Error("a call with function tools must not use Chat Completions");
  };
  return { responses: { create }, chat: { completions: { create: chatCreate } } } as never;
}

// A Responses API response, shaped the way `responses.create` returns it.
const responseWith = (
  output: unknown[],
  extra: { status?: string; incomplete_details?: unknown; usage?: unknown; error?: unknown } = {},
) => ({ object: "response", status: "completed", output, ...extra });
const textOutput = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
const functionCallOutput = (name: string, args: unknown, call_id = "call_1") => ({
  type: "function_call",
  id: `fc_${call_id}`,
  call_id,
  name,
  arguments: JSON.stringify(args),
});

const textRequest = (overrides: Partial<AgentTextRequest> = {}) =>
  ({
    name: "req",
    model: "quick",
    prompt: "hi",
    tools: {},
    ...overrides,
  }) as AgentTextRequest & { tools: AgentTools };

const outputSchema = z.object({ answer: z.string() });

// One OpenAI choice, shaped the way `chat.completions.create` returns it.
const choice = (content: string | null, finish_reason = "stop") => ({
  index: 0,
  message: { role: "assistant", content, refusal: null },
  finish_reason,
});

describe("request -> OpenAI param mapping (pure helpers)", () => {
  test("toOpenAiMessages: system + prompt lower to a system + user message", () => {
    expect(toOpenAiMessages({ system: "Be terse.", prompt: "Hi" })).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Hi" },
    ]);
  });

  test("toOpenAiMessages: messages array is mapped role-by-role when present", () => {
    const messages = toOpenAiMessages({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    } as Pick<AgentTextRequest, "system" | "prompt" | "messages">);
    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  test("toOpenAiMessages: a tool message becomes one OpenAI tool message per result part", () => {
    const messages = toOpenAiMessages({
      messages: [
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_1", output: { type: "text", value: "ok" } },
            {
              type: "tool-result",
              toolCallId: "call_2",
              output: { type: "json", value: { n: 1 } },
            },
          ],
        },
      ],
    } as Pick<AgentTextRequest, "system" | "prompt" | "messages">);
    expect(messages).toEqual([
      { role: "tool", content: "ok", tool_call_id: "call_1" },
      { role: "tool", content: '{"n":1}', tool_call_id: "call_2" },
    ]);
  });

  test("toOpenAiCallSettings maps to max_completion_tokens, not max_tokens", () => {
    expect(
      toOpenAiCallSettings({
        temperature: 0.5,
        maxOutputTokens: 100,
        topP: 0.9,
        seed: 42,
        stopSequences: ["END"],
      }),
    ).toEqual({
      temperature: 0.5,
      max_completion_tokens: 100,
      top_p: 0.9,
      seed: 42,
      stop: ["END"],
    });
  });

  test("toOpenAiCallSettings omits unset keys, so it cannot erase a host setting", () => {
    expect(toOpenAiCallSettings({ temperature: 0.5 })).toEqual({ temperature: 0.5 });
  });

  test("toOpenAiTools builds one function tool per AgentTools entry", () => {
    const tools = toOpenAiTools({
      lookup: { description: "Looks something up.", inputSchema: z.object({ query: z.string() }) },
    });
    expect(tools).toHaveLength(1);
    // Flat Responses API shape, with strict mode explicitly off (the
    // Responses API defaults it on).
    expect(tools[0]).toMatchObject({
      type: "function",
      name: "lookup",
      description: "Looks something up.",
      strict: false,
    });
  });

  test("toOpenAiEventTools builds one function tool per candidate event", () => {
    const tools = toOpenAiEventTools([
      { type: "ASK", toolName: "send_event_ASK" },
      { type: "GUESS", toolName: "send_event_GUESS" },
    ]);
    expect(tools.map((t) => t.name)).toEqual(["send_event_ASK", "send_event_GUESS"]);
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

describe("result mapping (pure helpers)", () => {
  test("toAgentCallUsage flattens OpenAI's nested token details", () => {
    expect(
      toAgentCallUsage({
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 7 },
        prompt_tokens_details: { cached_tokens: 4 },
      } as never),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      reasoningTokens: 7,
      cachedInputTokens: 4,
    });
  });

  test("toAgentCallUsage omits details the response did not report", () => {
    expect(
      toAgentCallUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } as never),
    ).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    expect(toAgentCallUsage(undefined)).toBeUndefined();
  });

  test("toAgentFinishReason maps OpenAI's vocabulary onto the portable union", () => {
    expect(toAgentFinishReason("stop")).toBe("stop");
    expect(toAgentFinishReason("length")).toBe("length");
    expect(toAgentFinishReason("tool_calls")).toBe("tool-calls");
    expect(toAgentFinishReason("function_call")).toBe("tool-calls");
    expect(toAgentFinishReason("content_filter")).toBe("content-filter");
    expect(toAgentFinishReason(null)).toBe("other");
  });
});

describe("createOpenAiExecutors: settings", () => {
  test("a `settings` map keyed by model ref applies to that ref's calls only", async () => {
    const create = vi.fn(async (_params: any) => ({ choices: [choice("hi")] }));
    const { generateText } = createOpenAiExecutors({
      client: stubClient(create),
      settings: { deep: { reasoning_effort: "high" }, quick: {} },
    });

    await generateText(textRequest({ model: "deep" }));
    expect(create.mock.calls[0]![0]).toMatchObject({ model: "deep", reasoning_effort: "high" });

    await generateText(textRequest({ model: "quick" }));
    expect(create.mock.calls[1]![0]).not.toHaveProperty("reasoning_effort");
  });

  test("a `settings` function sees the request and applies to every call", async () => {
    const create = vi.fn(async (_params: any) => ({ choices: [choice("hi")] }));
    const { generateText } = createOpenAiExecutors({
      client: stubClient(create),
      settings: (request) => ({ service_tier: request.name === "req" ? "flex" : "auto" }),
    });

    await generateText(textRequest());
    expect(create.mock.calls[0]![0]).toMatchObject({ service_tier: "flex" });
  });

  test("what the request declared wins over the host's settings", async () => {
    const create = vi.fn(async (_params: any) => ({ choices: [choice("hi")] }));
    const { generateText } = createOpenAiExecutors({
      client: stubClient(create),
      settings: { quick: { max_completion_tokens: 100, temperature: 0.1 } },
    });

    await generateText(textRequest({ maxOutputTokens: 999 }));
    // The request set `maxOutputTokens`; it did not set a temperature, so the
    // host's survives rather than being erased by an `undefined`.
    expect(create.mock.calls[0]![0]).toMatchObject({
      max_completion_tokens: 999,
      temperature: 0.1,
    });
  });

  test("`resolveModel` maps the machine's model ref to a real OpenAI id", async () => {
    const create = vi.fn(async (_params: any) => ({ choices: [choice("hi")] }));
    const { generateText } = createOpenAiExecutors({
      client: stubClient(create),
      resolveModel: () => "gpt-6-luna",
    });

    await generateText(textRequest());
    expect(create.mock.calls[0]![0]).toMatchObject({ model: "gpt-6-luna" });
  });
});

describe("createOpenAiExecutors: generateText", () => {
  test("text request reports usage and the mapped finish reason", async () => {
    const { generateText } = createOpenAiExecutors({
      client: stubClient(async () => ({
        choices: [choice("a joke")],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 3,
          total_tokens: 14,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      })),
    });

    const result = await generateText(textRequest());
    expect(result.result).toBe("a joke");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14,
      reasoningTokens: 2,
    });
  });

  test("a truncated TEXT request returns its text with finishReason 'length'", async () => {
    const { generateText } = createOpenAiExecutors({
      client: stubClient(async () => ({ choices: [choice("half a jo", "length")] })),
    });

    const result = await generateText(textRequest());
    expect(result).toMatchObject({ result: "half a jo", finishReason: "length" });
  });

  test("structured output goes through the { result } provider schema and is unwrapped", async () => {
    const create = vi.fn(async (_params: any) => ({
      choices: [choice(JSON.stringify({ result: { answer: "42" } }))],
    }));
    const { generateText } = createOpenAiExecutors({ client: stubClient(create) });

    const result = await generateText(textRequest({ outputSchema }));
    expect(create.mock.calls[0]![0].response_format).toMatchObject({ type: "json_schema" });
    expect(result.result).toEqual({ answer: "42" });
  });

  test("a truncated STRUCTURED request throws AgentTruncatedError with the partial text", async () => {
    const { generateText } = createOpenAiExecutors({
      client: stubClient(async () => ({ choices: [choice('{"result":{"answ', "length")] })),
    });

    const error = await generateText(textRequest({ outputSchema }), {
      requestId: "invoke-1",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentTruncatedError);
    expect(error).toMatchObject({
      code: "truncated",
      requestName: "req",
      requestId: "invoke-1",
      partialOutput: '{"result":{"answ',
    });
  });
});

describe("createOpenAiExecutors: streamText", () => {
  test("forwards chunks, asks for usage, and reports the stream's finish reason", async () => {
    const chunks = ["Why", " did", " the state machine cross the road?"];
    const create = vi.fn(async (_params: any) => ({
      async *[Symbol.asyncIterator]() {
        for (const content of chunks) {
          yield { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
        }
        yield { choices: [{ index: 0, delta: {}, finish_reason: "length" }] };
        // The usage chunk arrives last and carries no choices.
        yield {
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
        };
      },
    }));

    const { streamText } = createOpenAiExecutors({ client: stubClient(create) });
    const seen: string[] = [];
    const result = await streamText(textRequest(), { onChunk: (chunk) => seen.push(chunk) });

    expect(create.mock.calls[0]![0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(seen).toEqual(chunks);
    expect(result.result).toBe(chunks.join(""));
    expect(result.finishReason).toBe("length");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 9, totalTokens: 14 });
  });

  test("text-only: a structured or tool-carrying request is refused, not downgraded", async () => {
    const create = vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} }));
    const { streamText } = createOpenAiExecutors({ client: stubClient(create) });

    await expect(streamText(textRequest({ outputSchema }))).rejects.toThrow(/text-only/);
    await expect(
      streamText(
        textRequest({
          tools: { lookup: { inputSchema: z.object({ query: z.string() }) } },
        } as never),
      ),
    ).rejects.toThrow(/text-only/);
    // Neither reached the network.
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createOpenAiExecutors: decide", () => {
  const decisionRequest = {
    name: "pick",
    model: "quick",
    prompt: "Pick a move.",
    events: [
      { type: "ASK", toolName: "send_event_ASK" },
      { type: "GUESS", toolName: "send_event_GUESS" },
    ],
    attempts: [],
  } as unknown as AgentDecisionRequest;

  test("forces a tool call through the Responses API and maps it back to a machine event", async () => {
    const create = vi.fn(async (_params: any) =>
      responseWith([functionCallOutput("send_event_GUESS", { guess: "a cat", type: "SPOOF" })], {
        usage: {
          input_tokens: 8,
          output_tokens: 2,
          total_tokens: 10,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      }),
    );
    const { decide } = createOpenAiExecutors({
      client: stubResponsesClient(create),
      resolveModel: () => "gpt-6-luna",
    });

    const result = await decide(decisionRequest);
    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({
      model: "gpt-6-luna",
      input: [{ role: "user", content: "Pick a move." }],
      tool_choice: "required",
      store: false,
    });
    expect(params.tools).toEqual([
      expect.objectContaining({ type: "function", name: "send_event_ASK", strict: false }),
      expect.objectContaining({ type: "function", name: "send_event_GUESS", strict: false }),
    ]);
    expect(params).not.toHaveProperty("messages");
    // The event descriptor's own `type` wins over a stray `type` in the input.
    expect(result.event).toEqual({ guess: "a cat", type: "GUESS" });
    expect(result.finishReason).toBe("tool-calls");
    expect(result.usage).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      reasoningTokens: 1,
    });
  });

  test("host Chat Completions settings are translated onto Responses API names", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const create = vi.fn(async (_params: any) =>
      responseWith([functionCallOutput("send_event_ASK", {})]),
    );
    const { decide } = createOpenAiExecutors({
      client: stubResponsesClient(create),
      settings: {
        quick: {
          reasoning_effort: "high",
          max_completion_tokens: 500,
          verbosity: "low",
          seed: 1,
          stop: ["END"],
          logprobs: true,
          prediction: { type: "content", content: "x" },
          service_tier: "flex",
        },
      },
    });

    await decide(decisionRequest);
    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({
      reasoning: { effort: "high" },
      max_output_tokens: 500,
      text: { verbosity: "low" },
      service_tier: "flex",
    });
    for (const key of [
      "reasoning_effort",
      "max_completion_tokens",
      "verbosity",
      "seed",
      "stop",
      "logprobs",
      "prediction",
    ]) {
      expect(params).not.toHaveProperty(key);
    }
  });

  test("dropped settings warn once per key per executors instance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { decide } = createOpenAiExecutors({
      client: stubResponsesClient(async () =>
        responseWith([functionCallOutput("send_event_ASK", {})]),
      ),
      settings: { quick: { logprobs: true, service_tier: "flex" } },
    });
    const seeded = { ...decisionRequest, seed: 7, stopSequences: ["END"] };

    await decide(seeded);
    await decide(seeded);
    const dropped = warn.mock.calls.map(([message]) => String(message).match(/`(\w+)`/)?.[1]);
    expect(dropped.sort()).toEqual(["logprobs", "seed", "stop"]);
  });

  test("a setting the model rejects is dropped for that model and retried once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const create = vi.fn(async (params: any) => {
      if ("temperature" in params) {
        throw Object.assign(
          new Error("400 Unsupported parameter: 'temperature' is not supported with this model."),
          { status: 400, code: "unsupported_parameter", param: "temperature" },
        );
      }
      return responseWith([functionCallOutput("send_event_ASK", {})]);
    });
    const { decide } = createOpenAiExecutors({ client: stubResponsesClient(create) });
    const warm = { ...decisionRequest, temperature: 0.3 };

    expect((await decide(warm)).event).toEqual({ type: "ASK" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).not.toHaveProperty("temperature");

    // The model remembers the rejection: no second 400, no second warning.
    await decide(warm);
    expect(create).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("`quick` does not support `temperature`");
  });

  test("other 400s are not retried", async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error("400 Unsupported parameter: 'input'"), {
        status: 400,
        param: "input",
      });
    });
    const { decide } = createOpenAiExecutors({ client: stubResponsesClient(create) });
    await expect(decide({ ...decisionRequest, temperature: 0.3 } as never)).rejects.toThrow(
      "Unsupported parameter: 'input'",
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("an incomplete response's call is not accepted as a choice", async () => {
    const { decide } = createOpenAiExecutors({
      client: stubResponsesClient(async () =>
        responseWith([functionCallOutput("send_event_ASK", {})], {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    });
    await expect(decide(decisionRequest)).rejects.toThrow(/incomplete \(max_output_tokens\)/);
  });

  test("a failed response is an error", async () => {
    const { decide } = createOpenAiExecutors({
      client: stubResponsesClient(async () =>
        responseWith([], {
          status: "failed",
          error: { code: "server_error", message: "The model failed." },
        }),
      ),
    });
    await expect(decide(decisionRequest)).rejects.toThrow(
      "decide — the Responses API call failed (server_error: The model failed.)",
    );
  });

  // One reply per model call, in order; each is a function call or plain text.
  const replies = (...messages: Array<{ name: string; arguments: string } | string>) => {
    const create = vi.fn(async () => {
      const reply = messages[create.mock.calls.length - 1]!;
      return responseWith(
        [
          typeof reply === "string"
            ? textOutput(reply)
            : { type: "function_call", call_id: "call_1", ...reply },
        ],
        { usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } },
      );
    });
    return createOpenAiExecutors({ client: stubResponsesClient(create) });
  };
  const ask = { name: "send_event_ASK", arguments: "{}" };
  const reasons = (request: AgentDecisionRequest) =>
    request.attempts.map((attempt) => [attempt.failure, attempt.reason]);

  test("a reply with no tool call is retried, its usage still reported", async () => {
    const { decide } = replies("I would rather not.", ask);
    const result = await decide(decisionRequest);
    expect(result.rejected).toEqual({
      failure: "unknown-event",
      reason: "no tool was called; call exactly one of: send_event_ASK, send_event_GUESS",
    });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });

    const seen: AgentDecisionRequest[] = [];
    const { decide: retrying } = replies("I would rather not.", ask);
    const event = await resolveDecision(decisionRequest, {
      decide: (attempt, info) => (seen.push(attempt), retrying(attempt, info)),
    });
    expect(event).toEqual({ type: "ASK" });
    expect(reasons(seen[1]!)).toEqual([
      [
        "unknown-event",
        "no tool was called; call exactly one of: send_event_ASK, send_event_GUESS",
      ],
    ]);
  });

  test("a call to an unknown tool is retried, naming the valid tools", async () => {
    const seen: AgentDecisionRequest[] = [];
    const { decide } = replies({ name: "send_event_QUIT", arguments: "{}" }, ask);
    const event = await resolveDecision(decisionRequest, {
      decide: (attempt, info) => (seen.push(attempt), decide(attempt, info)),
    });
    expect(event).toEqual({ type: "ASK" });
    expect(reasons(seen[1]!)).toEqual([
      [
        "unknown-event",
        "tool 'send_event_QUIT' was not offered; valid tools: send_event_ASK, send_event_GUESS",
      ],
    ]);
  });

  test("malformed tool arguments are retried as an invalid payload", async () => {
    const seen: AgentDecisionRequest[] = [];
    const { decide } = replies({ name: "send_event_GUESS", arguments: '{"guess": "a c' }, ask);
    const event = await resolveDecision(decisionRequest, {
      decide: (attempt, info) => (seen.push(attempt), decide(attempt, info)),
    });
    expect(event).toEqual({ type: "ASK" });
    expect(reasons(seen[1]!)).toEqual([
      ["invalid-payload", "the arguments for tool 'send_event_GUESS' were not valid JSON"],
    ]);
  });

  test("answers that never name a candidate exhaust the retries", async () => {
    const { decide } = replies("no", "still no", "never");
    const error = await resolveDecision(decisionRequest, { decide }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentDecisionExhaustedError);
    expect((error as AgentDecisionExhaustedError).attempts).toHaveLength(3);
    expect((error as AgentDecisionExhaustedError).attempts.map((a) => a.failure)).toEqual([
      "unknown-event",
      "unknown-event",
      "unknown-event",
    ]);
  });
});

describe("message conversion: multi-part content", () => {
  test("a user message's text and image parts map onto OpenAI content parts", () => {
    const messages = toOpenAiMessages({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", image: "https://example.com/cat.png" },
            { type: "image", image: "AAAA", mediaType: "image/png" },
          ],
        },
      ],
    } as Pick<AgentTextRequest, "system" | "prompt" | "messages">);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  test("an assistant tool call round-trips through OpenAI `tool_calls` and back as a tool message", () => {
    const messages = toOpenAiMessages({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking it up." },
            { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "cats" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup",
              output: { type: "text", value: "9 lives" },
            },
          ],
        },
      ],
    } as Pick<AgentTextRequest, "system" | "prompt" | "messages">);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: "Looking it up.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: JSON.stringify({ q: "cats" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "9 lives" },
    ]);
  });

  test("toResponsesInput maps tool calls, tool results, and images onto Responses items", () => {
    const input = toResponsesInput(
      toOpenAiMessages({
        messages: [
          { role: "system", content: "sys" },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image", image: "https://example.com/cat.png" },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Looking it up." },
              { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "cats" } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "lookup",
                output: { type: "text", value: "9 lives" },
              },
            ],
          },
        ],
      } as Pick<AgentTextRequest, "system" | "prompt" | "messages">),
    );
    expect(input).toEqual([
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is this?" },
          { type: "input_image", image_url: "https://example.com/cat.png", detail: "auto" },
        ],
      },
      { role: "assistant", content: "Looking it up." },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: JSON.stringify({ q: "cats" }),
      },
      { type: "function_call_output", call_id: "call_1", output: "9 lives" },
    ]);
  });

  test("a part Chat Completions cannot carry throws instead of being dropped", () => {
    expect(() =>
      toOpenAiMessages({
        messages: [
          {
            role: "user",
            content: [{ type: "file", data: "AAAA", mediaType: "application/pdf" }],
          },
        ],
      } as Pick<AgentTextRequest, "system" | "prompt" | "messages">),
    ).toThrow(/type 'file' has no Chat Completions equivalent/);
  });
});

describe("createOpenAiExecutors: tool loop", () => {
  const tools = {
    lookup: {
      description: "Looks something up.",
      inputSchema: z.object({ q: z.string() }),
      execute: ({ q }: { q: string }) => `${q}: 9 lives`,
    },
  } as unknown as AgentTools;

  test("a loop that fails after a step reports the calls it made on the error", async () => {
    const create = vi.fn(async (_params: any) => {
      if (create.mock.calls.length === 1) {
        return responseWith([functionCallOutput("lookup", { q: "cats" })]);
      }
      throw new Error("upstream down");
    });
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    await expect(generateText(textRequest({ tools, maxSteps: 4 } as never))).rejects.toMatchObject({
      message: "upstream down",
      modelCalls: 2,
    });
  });

  test("runs the tool over the Responses API, feeds the result back, and returns the final text", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? responseWith(
            [
              { type: "reasoning", id: "rs_1", summary: [] },
              functionCallOutput("lookup", { q: "cats" }),
            ],
            {
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          )
        : responseWith([textOutput("Cats have 9 lives.")], {
            usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
          }),
    );
    const { generateText } = createOpenAiExecutors({
      client: stubResponsesClient(create),
      resolveModel: () => "gpt-6-luna",
    });

    const result = await generateText(textRequest({ tools, maxSteps: 4 } as never));

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.modelCalls).toBe(2);
    expect(create.mock.calls[0]![0]).toMatchObject({
      model: "gpt-6-luna",
      input: [{ role: "user", content: "hi" }],
      tools: [expect.objectContaining({ type: "function", name: "lookup", strict: false })],
      store: false,
    });
    expect(result.result).toBe("Cats have 9 lives.");
    expect(result.finishReason).toBe("stop");
    // The second call replays the call without its item id or the reasoning
    // item (nothing is stored), then the tool's output.
    expect(create.mock.calls[1]![0].input).toEqual([
      { role: "user", content: "hi" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: JSON.stringify({ q: "cats" }),
      },
      { type: "function_call_output", call_id: "call_1", output: "cats: 9 lives" },
    ]);
    // Every step's usage is folded into the one result the run aggregates.
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 9, totalTokens: 39 });
  });

  test("structured output with tools uses a Responses `text.format` json_schema", async () => {
    const create = vi.fn(async (_params: any) =>
      responseWith([textOutput(JSON.stringify({ result: { answer: "42" } }))]),
    );
    const { generateText } = createOpenAiExecutors({
      client: stubResponsesClient(create),
      settings: { quick: { verbosity: "low" } },
    });

    const result = await generateText(textRequest({ tools, outputSchema } as never));
    expect(create.mock.calls[0]![0].text).toMatchObject({
      verbosity: "low",
      format: { type: "json_schema", name: "output", strict: false },
    });
    expect(result.result).toEqual({ answer: "42" });
  });

  test("a structured request with tools that hits max_output_tokens throws AgentTruncatedError", async () => {
    const { generateText } = createOpenAiExecutors({
      client: stubResponsesClient(async () =>
        responseWith([textOutput('{"result":{"answ')], {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    });

    const error = await generateText(textRequest({ tools, outputSchema } as never)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentTruncatedError);
    expect(error).toMatchObject({ partialOutput: '{"result":{"answ' });
  });

  test("a zero-argument call with empty arguments is replayed as `{}`", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? responseWith([{ type: "function_call", call_id: "call_1", name: "ping", arguments: "" }])
        : responseWith([textOutput("pong")]),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    await generateText(
      textRequest({
        tools: { ping: { inputSchema: z.object({}), execute: () => "ok" } },
        maxSteps: 2,
      } as never),
    );
    expect(create.mock.calls[1]![0].input).toContainEqual({
      type: "function_call",
      call_id: "call_1",
      name: "ping",
      arguments: "{}",
    });
  });

  test("an incomplete turn never runs its calls", async () => {
    const execute = vi.fn(() => "charged");
    const create = vi.fn(async (_params: any) =>
      responseWith([functionCallOutput("charge", {})], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    const result = await generateText(
      textRequest({
        tools: { charge: { inputSchema: z.object({}), execute } },
        maxSteps: 2,
      } as never),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe("length");
  });

  test("a failed step is an error, not an empty result", async () => {
    const { generateText } = createOpenAiExecutors({
      client: stubResponsesClient(async () =>
        responseWith([], {
          status: "failed",
          error: { code: "server_error", message: "The model failed." },
        }),
      ),
    });
    await expect(
      generateText(textRequest({ tools: { lookup: { inputSchema: z.object({}) } } } as never)),
    ).rejects.toThrow("generateText — the Responses API call failed");
  });

  test("`maxSteps` bounds the loop; the default is a single call", async () => {
    const create = vi.fn(async (_params: any) =>
      responseWith([functionCallOutput("lookup", { q: "cats" })]),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    const bounded = await generateText(textRequest({ tools, maxSteps: 3 } as never));
    expect(create).toHaveBeenCalledTimes(3);
    expect(bounded.finishReason).toBe("tool-calls");

    create.mockClear();
    await generateText(textRequest({ tools } as never));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("a non-finite `maxSteps` falls back to the single-call default", async () => {
    const create = vi.fn(async (_params: any) =>
      responseWith([functionCallOutput("lookup", { q: "cats" })]),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    for (const maxSteps of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.7]) {
      create.mockClear();
      await generateText(textRequest({ tools, maxSteps } as never));
      expect(create).toHaveBeenCalledTimes(Number.isFinite(maxSteps) && maxSteps >= 1 ? 2 : 1);
    }
  });

  test("a tool with no `execute` ends the loop and hands the call back", async () => {
    const create = vi.fn(async (_params: any) =>
      responseWith([functionCallOutput("clientSide", {})]),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    const result = await generateText(
      textRequest({
        tools: { clientSide: { inputSchema: z.object({}) } },
        maxSteps: 5,
      } as never),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe("tool-calls");
  });

  test("a thrown tool goes back to the model as an error result", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? responseWith([functionCallOutput("lookup", { q: "cats" })])
        : responseWith([textOutput("Sorry, the lookup failed.")]),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    const result = await generateText(
      textRequest({
        tools: {
          lookup: {
            inputSchema: z.object({ q: z.string() }),
            execute: () => {
              throw new Error("boom");
            },
          },
        },
        maxSteps: 2,
      } as never),
    );
    expect(create.mock.calls[1]![0].input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "Error: boom",
    });
    expect(result.result).toBe("Sorry, the lookup failed.");
  });

  test("an unknown tool or arguments that are not JSON go back to the model as error results", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? responseWith([
            { type: "function_call", call_id: "call_1", name: "search", arguments: "{}" },
            { type: "function_call", call_id: "call_2", name: "lookup", arguments: "{q:" },
          ])
        : responseWith([textOutput("Let me try again.")]),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    // An `undefined` entry is not sent to OpenAI, so it is not offered either.
    const result = await generateText(
      textRequest({ tools: { ...tools, search: undefined }, maxSteps: 2 } as never),
    );

    expect(
      create.mock.calls[1]![0].input.filter(
        (item: { type?: string }) => item.type === "function_call_output",
      ),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Error: tool 'search' was not offered; valid tools: lookup",
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: "Error: the arguments for tool 'lookup' were not valid JSON",
      },
    ]);
    expect(result.result).toBe("Let me try again.");
  });

  test("`toolChoice` is mapped onto the Responses `tool_choice`, on the first step only", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? responseWith([functionCallOutput("lookup", { q: "cats" })])
        : responseWith([textOutput("done")]),
    );
    const { generateText } = createOpenAiExecutors({ client: stubResponsesClient(create) });

    await generateText(
      textRequest({ tools, maxSteps: 3, toolChoice: { type: "tool", name: "lookup" } } as never),
    );
    expect(create.mock.calls[0]![0].tool_choice).toEqual({ type: "function", name: "lookup" });
    // Re-forcing a tool every step would burn the budget without an answer.
    expect(create.mock.calls[1]![0]).not.toHaveProperty("tool_choice");

    create.mockClear();
    await generateText(textRequest({ tools, toolChoice: "required" } as never));
    expect(create.mock.calls[0]![0].tool_choice).toBe("required");

    create.mockClear();
    await generateText(textRequest({ tools } as never));
    expect(create.mock.calls[0]![0]).not.toHaveProperty("tool_choice");
  });
});

describe("createOpenAiExecutors: api 'responses'", () => {
  function responsesClient(create: (params: any, options?: any) => unknown) {
    return { responses: { create } } as never;
  }
  const message = (text: string) => ({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  });
  const functionCall = (name: string, args: unknown, call_id = "call_1") => ({
    type: "function_call",
    call_id,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  });
  const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };

  test("generateText: text via responses.create with input items and mapped usage", async () => {
    const create = vi.fn(async (_params: any) => ({
      status: "completed",
      output: [message("hello")],
      usage,
    }));
    const { generateText } = createOpenAiExecutors({
      client: responsesClient(create),
      api: "responses",
    });
    const result = await generateText(
      textRequest({ system: "Be terse.", maxOutputTokens: 10 } as never),
    );
    expect(create.mock.calls[0]![0]).toMatchObject({
      model: "quick",
      input: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
      max_output_tokens: 10,
    });
    expect(result).toMatchObject({
      result: "hello",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      finishReason: "stop",
    });
    expect(result.raw).toEqual(await create.mock.results[0]!.value);
  });

  test("generateText: structured output goes through text.format json_schema", async () => {
    const create = vi.fn(async (_params: any) => ({
      status: "completed",
      output: [message(JSON.stringify({ result: { answer: "42" } }))],
    }));
    const { generateText } = createOpenAiExecutors({
      client: responsesClient(create),
      api: "responses",
    });
    const result = await generateText(textRequest({ outputSchema } as never));
    expect(create.mock.calls[0]![0].text.format).toMatchObject({
      type: "json_schema",
      name: "output",
    });
    expect(result.result).toEqual({ answer: "42" });
  });

  test("generateText: tool loop via function_call / function_call_output, bounded by maxSteps", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? { status: "completed", output: [functionCall("lookup", { q: "cats" })], usage }
        : { status: "completed", output: [message("Cats are great.")], usage },
    );
    const { generateText } = createOpenAiExecutors({
      client: responsesClient(create),
      api: "responses",
    });
    const result = await generateText(
      textRequest({
        tools: {
          lookup: {
            description: "Look it up",
            inputSchema: z.object({ q: z.string() }),
            execute: ({ q }: { q: string }) => ({ found: q }),
          },
        },
        maxSteps: 3,
      } as never),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![0].tools[0]).toMatchObject({
      type: "function",
      name: "lookup",
      description: "Look it up",
    });
    expect(create.mock.calls[1]![0].input.slice(-2)).toEqual([
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"cats"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"found":"cats"}' },
    ]);
    expect(result.result).toBe("Cats are great.");
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 4, totalTokens: 10 });
  });

  test("streamText: forwards output_text deltas and takes usage from response.completed", async () => {
    const create = vi.fn(async function* (_params: any) {
      yield { type: "response.output_text.delta", delta: "Hel" };
      yield { type: "response.output_text.delta", delta: "lo" };
      yield { type: "response.completed", response: { status: "completed", output: [], usage } };
    });
    const { streamText } = createOpenAiExecutors({
      client: responsesClient((params) => create(params)),
      api: "responses",
    });
    const chunks: string[] = [];
    const result = await streamText(textRequest(), {
      onChunk: (c: string) => chunks.push(c),
    } as never);
    expect(create.mock.calls[0]![0].stream).toBe(true);
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(result).toMatchObject({
      result: "Hello",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      finishReason: "stop",
    });
  });

  const decisionRequest = {
    name: "pick",
    model: "quick",
    prompt: "choose",
    events: [{ type: "approve", toolName: "approve", inputSchema: z.object({ note: z.string() }) }],
    attempts: [],
  } as unknown as AgentDecisionRequest;

  test("decide: forces a function tool and maps the call back to an event", async () => {
    const create = vi.fn(async (_params: any) => ({
      status: "completed",
      output: [functionCall("approve", { note: "ok", type: "nope" })],
    }));
    const { decide } = createOpenAiExecutors({ client: responsesClient(create), api: "responses" });
    const result = await decide(decisionRequest);
    expect(create.mock.calls[0]![0]).toMatchObject({
      tool_choice: "required",
      tools: [{ type: "function", name: "approve" }],
    });
    expect(result.event).toEqual({ type: "approve", note: "ok" });
    expect(result.finishReason).toBe("tool-calls");
  });

  test("decide: an unknown tool or non-JSON arguments come back rejected, to be retried", async () => {
    const unknown = createOpenAiExecutors({
      client: responsesClient(async () => ({ output: [functionCall("other", {})] })),
      api: "responses",
    });
    expect((await unknown.decide(decisionRequest)).rejected).toMatchObject({
      failure: "unknown-event",
    });
    const invalid = createOpenAiExecutors({
      client: responsesClient(async () => ({ output: [functionCall("approve", "{not json")] })),
      api: "responses",
    });
    expect((await invalid.decide(decisionRequest)).rejected).toMatchObject({
      failure: "invalid-payload",
    });
  });
});
