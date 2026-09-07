import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { AgentTruncatedError } from "../errors.js";
import type { AgentDecisionRequest } from "../decision.js";
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
} from "./index.js";

// A stubbed `OpenAI` client: only `chat.completions.create` is ever called, so
// the whole SDK surface reduces to one function. No network.
function stubClient(create: (params: any, options?: any) => unknown) {
  return { chat: { completions: { create } } } as never;
}

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
    expect(tools[0]).toMatchObject({
      type: "function",
      function: { name: "lookup", description: "Looks something up." },
    });
  });

  test("toOpenAiEventTools builds one function tool per candidate event", () => {
    const tools = toOpenAiEventTools([
      { type: "ASK", toolName: "send_event_ASK" },
      { type: "GUESS", toolName: "send_event_GUESS" },
    ]);
    expect(tools.map((t) => (t as { function: { name: string } }).function.name)).toEqual([
      "send_event_ASK",
      "send_event_GUESS",
    ]);
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
      resolveModel: () => "gpt-5.4-mini",
    });

    await generateText(textRequest());
    expect(create.mock.calls[0]![0]).toMatchObject({ model: "gpt-5.4-mini" });
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
    expect(result.output).toBe("a joke");
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
    expect(result).toMatchObject({ output: "half a jo", finishReason: "length" });
  });

  test("structured output goes through the { result } envelope and is unwrapped", async () => {
    const create = vi.fn(async (_params: any) => ({
      choices: [choice(JSON.stringify({ result: { answer: "42" } }))],
    }));
    const { generateText } = createOpenAiExecutors({ client: stubClient(create) });

    const result = await generateText(textRequest({ outputSchema }));
    expect(create.mock.calls[0]![0].response_format).toMatchObject({ type: "json_schema" });
    expect(result.output).toEqual({ answer: "42" });
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
    expect(result.output).toBe(chunks.join(""));
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

  test("forces a tool call and maps it back to a machine event", async () => {
    const create = vi.fn(async (_params: any) => ({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "send_event_GUESS",
                  arguments: JSON.stringify({ guess: "a cat", type: "SPOOF" }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    }));
    const { decide } = createOpenAiExecutors({ client: stubClient(create) });

    const result = await decide(decisionRequest);
    expect(create.mock.calls[0]![0]).toMatchObject({ tool_choice: "required" });
    // The event descriptor's own `type` wins over a stray `type` in the input.
    expect(result.event).toEqual({ guess: "a cat", type: "GUESS" });
    expect(result.finishReason).toBe("tool-calls");
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  });

  test("a reply with no tool call is an error", async () => {
    const { decide } = createOpenAiExecutors({
      client: stubClient(async () => ({ choices: [choice("I would rather not.")] })),
    });
    await expect(decide(decisionRequest)).rejects.toThrow("did not call an event tool");
  });
});

// One choice whose message is a tool call, shaped the way OpenAI returns it.
const toolCallChoice = (name: string, args: unknown, id = "call_1") => ({
  index: 0,
  finish_reason: "tool_calls",
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  },
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

  test("runs the tool, feeds the result back, and returns the model's final text", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? {
            choices: [toolCallChoice("lookup", { q: "cats" })],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }
        : {
            choices: [choice("Cats have 9 lives.")],
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          },
    );
    const { generateText } = createOpenAiExecutors({ client: stubClient(create) });

    const result = await generateText(textRequest({ tools, maxSteps: 4 } as never));

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.output).toBe("Cats have 9 lives.");
    expect(result.finishReason).toBe("stop");
    // The second call carries the assistant tool_calls message and the result.
    expect(create.mock.calls[1]![0].messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant" }),
      { role: "tool", tool_call_id: "call_1", content: "cats: 9 lives" },
    ]);
    // Every step's usage is folded into the one result the run aggregates.
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 9, totalTokens: 39 });
  });

  test("`maxSteps` bounds the loop; the default is a single call", async () => {
    const create = vi.fn(async (_params: any) => ({
      choices: [toolCallChoice("lookup", { q: "cats" })],
    }));
    const { generateText } = createOpenAiExecutors({ client: stubClient(create) });

    const bounded = await generateText(textRequest({ tools, maxSteps: 3 } as never));
    expect(create).toHaveBeenCalledTimes(3);
    expect(bounded.finishReason).toBe("tool-calls");

    create.mockClear();
    await generateText(textRequest({ tools } as never));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("a tool with no `execute` ends the loop and hands the call back", async () => {
    const create = vi.fn(async (_params: any) => ({
      choices: [toolCallChoice("clientSide", {})],
    }));
    const { generateText } = createOpenAiExecutors({ client: stubClient(create) });

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
        ? { choices: [toolCallChoice("lookup", { q: "cats" })] }
        : { choices: [choice("Sorry, the lookup failed.")] },
    );
    const { generateText } = createOpenAiExecutors({ client: stubClient(create) });

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
    expect(create.mock.calls[1]![0].messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Error: boom",
    });
    expect(result.output).toBe("Sorry, the lookup failed.");
  });

  test("`toolChoice` is mapped onto OpenAI's `tool_choice`, on the first step only", async () => {
    const create = vi.fn(async (_params: any) =>
      create.mock.calls.length === 1
        ? { choices: [toolCallChoice("lookup", { q: "cats" })] }
        : { choices: [choice("done")] },
    );
    const { generateText } = createOpenAiExecutors({ client: stubClient(create) });

    await generateText(
      textRequest({ tools, maxSteps: 3, toolChoice: { type: "tool", name: "lookup" } } as never),
    );
    expect(create.mock.calls[0]![0].tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
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
