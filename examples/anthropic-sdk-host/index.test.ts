import { describe, expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages.js";
import { runAgent } from "@statelyai/agent";
import { getJsonSchemaSync } from "@statelyai/agent";
import type { AgentMessage } from "@statelyai/agent";
import {
  createAnthropicExecutors,
  toAnthropicCallSettings,
  toAnthropicEventTools,
  toAnthropicMessages,
  toAnthropicTools,
  toDecisionMessages,
} from "./index.js";
import { triageMachine, triageSchema } from "../triage/index.js";
import { twentyQuestionsMachine } from "../twenty-questions/index.js";

// A minimal Standard Schema fixture exposing the optional
// `~standard.jsonSchema` extension, mirroring what Zod v4's `z.toJSONSchema`
// produces.
function fakeSchema(jsonSchema: Record<string, unknown>) {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => jsonSchema,
      },
    },
  } as const;
}

function textMessage(): Message {
  return {
    id: "msg_1",
    container: null,
    content: [{ type: "text", text: "hi", citations: null }] as Message["content"],
    model: "claude-sonnet-4-5" as Message["model"],
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: 1,
      output_tokens: 1,
      server_tool_use: null,
      service_tier: null,
    } as Message["usage"],
  };
}

function toolUseMessage(name: string, input: unknown): Message {
  return {
    ...textMessage(),
    content: [
      { type: "tool_use", id: "toolu_1", name, input, caller: { type: "direct" } },
    ] as Message["content"],
    stop_reason: "tool_use",
  };
}

describe("toAnthropicMessages", () => {
  test("drops system-role messages", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hello" },
    ];
    expect(toAnthropicMessages(messages)).toEqual([{ role: "user", content: "hello" }]);
  });

  test("passes through string-content user/assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ]);
  });

  test("flattens parts-array content to text-only, dropping non-text parts", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", image: "data:image/png;base64,abc", mediaType: "image/png" },
          { type: "text", text: "and this" },
        ],
      },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      { role: "user", content: "look at this\nand this" },
    ]);
  });

  test("maps a tool-role AgentMessage to a user-role message with a tool_result block", () => {
    const messages: AgentMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "lookup",
            output: { type: "text", value: "found it" },
          },
        ],
      },
    ];

    expect(toAnthropicMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "found it",
          },
        ],
      },
    ]);
  });

  test("marks tool_result blocks as errors and stringifies json output", () => {
    const messages: AgentMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_2",
            toolName: "lookup",
            output: { type: "error-json", value: { message: "boom" } },
          },
        ],
      },
    ];

    expect(toAnthropicMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: JSON.stringify({ message: "boom" }),
            is_error: true,
          },
        ],
      },
    ]);
  });
});

describe("toAnthropicCallSettings", () => {
  test("defaults max_tokens and drops seed", () => {
    expect(toAnthropicCallSettings({ model: "claude", seed: 42 })).toEqual({
      max_tokens: 1024,
      temperature: undefined,
      top_p: undefined,
      top_k: undefined,
      stop_sequences: undefined,
    });
  });

  test("passes through provided settings", () => {
    expect(
      toAnthropicCallSettings({
        model: "claude",
        maxOutputTokens: 500,
        temperature: 0.5,
        topP: 0.9,
        topK: 40,
        stopSequences: ["STOP"],
      }),
    ).toEqual({
      max_tokens: 500,
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["STOP"],
    });
  });
});

describe("toAnthropicTools", () => {
  test("maps AgentTools entries to {name, description, input_schema}", () => {
    const tools = toAnthropicTools({
      search: {
        description: "Search the web",
        inputSchema: fakeSchema({ type: "object", properties: { q: { type: "string" } } }),
      },
    });
    expect(tools).toEqual([
      {
        name: "search",
        description: "Search the web",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
  });
});

describe("toAnthropicEventTools / decide shape", () => {
  test("decision events map to tools with input_schema derived from getJsonSchemaSync", () => {
    const tools = toAnthropicEventTools([
      {
        type: "ASK",
        toolName: "ask",
        inputSchema: fakeSchema({ type: "object", properties: { question: { type: "string" } } }),
      },
      { type: "GUESS", toolName: "guess" },
    ]);

    expect(tools).toEqual([
      {
        name: "ask",
        description: "Choose the 'ASK' move.",
        input_schema: { type: "object", properties: { question: { type: "string" } } },
      },
      {
        name: "guess",
        description: "Choose the 'GUESS' move.",
        input_schema: { type: "object" },
      },
    ]);
  });
});

describe("getJsonSchemaSync", () => {
  test("extracts the schema from ~standard.jsonSchema.input()", () => {
    const schema = fakeSchema({ type: "object", properties: {} });
    expect(getJsonSchemaSync(schema)).toEqual({ type: "object", properties: {} });
  });

  test("returns undefined when the extension is absent", () => {
    const schema = {
      "~standard": { version: 1, vendor: "test", validate: (v: unknown) => ({ value: v }) },
    } as const;
    expect(getJsonSchemaSync(schema)).toBeUndefined();
  });

  test("a structured-output request extracted schema flows into a forced-tool shape", () => {
    const schema = fakeSchema({ type: "object", properties: { sentiment: { type: "string" } } });
    const jsonSchema = getJsonSchemaSync(schema);
    expect(jsonSchema).toBeDefined();
    const tool = {
      name: "respond_with_output",
      description: "Provide the final structured output.",
      input_schema: { type: "object", ...jsonSchema },
    };
    expect(tool.input_schema).toEqual({
      type: "object",
      properties: { sentiment: { type: "string" } },
    });
  });
});

describe("toDecisionMessages", () => {
  test("renders prior failed attempts as appended user-message feedback", () => {
    const messages = toDecisionMessages({
      prompt: "Pick a move",
      events: [
        { type: "ASK", toolName: "ask" },
        { type: "GUESS", toolName: "guess" },
      ],
      attempts: [{ failure: "unknown-event", reason: "called an unknown tool" }],
    });

    expect(messages).toEqual([
      { role: "user", content: "Pick a move" },
      {
        role: "user",
        content:
          "Your previous choice failed: called an unknown tool. Choose again from: ASK, GUESS",
      },
    ]);
  });
});

// ─── Full runAgent pass against a stubbed Anthropic client ───

// Anthropic['messages']['create'] is an overloaded, response-shape-branching
// signature (streaming vs non-streaming) that a plain async mock can't
// satisfy structurally — narrowing through `unknown` is the documented way
// to stub SDK client methods for tests here.
function stubClient(create: (params: unknown) => Promise<Message>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

describe("createAnthropicExecutors + runAgent", () => {
  test("generateText: structured output via forced tool call drives the triage machine", async () => {
    // The forced tool's input schema is the `{ result }` envelope; the model
    // fills it in kind, and the host unwraps `.result` before validation.
    const client = stubClient(async () =>
      toolUseMessage("respond_with_output", {
        result: {
          sentiment: "negative",
          category: "billing",
          reply: "Sorry about that, we will fix your invoice.",
        },
      }),
    );

    const { generateText } = createAnthropicExecutors({ client });
    const result = await runAgent(triageMachine, {
      input: { ticket: "My invoice is wrong and I am furious." },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(triageSchema.parse(result.output)).toEqual({
      sentiment: "negative",
      category: "billing",
      reply: "Sorry about that, we will fix your invoice.",
    });
  });

  test("decide: tool_choice any drives the twenty-questions machine to a guess", async () => {
    let call = 0;
    const client = stubClient(async (params) => {
      call += 1;
      const { tools } = params as { tools?: { name: string }[] };
      // The classify* text calls have no `tools` — respond with plain text.
      if (!tools || tools.length === 0) {
        return textMessage();
      }
      // Decision calls carry one event tool per candidate event, named via
      // the event's `toolName` (e.g. `send_event_GUESS`).
      const guessTool = tools.find((t) => t.name.includes("GUESS"));
      return toolUseMessage(guessTool!.name, { guess: "a cat" });
    });

    const { generateText, decide } = createAnthropicExecutors({ client });
    const executors = { generateText, decide };

    // Player turns are idle states now: the decide round-trip settles the run
    // at `awaitingGuessFeedback`, and scripted button events resume it to done.
    let result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 1 },
      executors,
    });
    expect(result.status).toBe("idle");

    const playerEvents = [{ type: "GUESS_RIGHT" }, { type: "PLAY_AGAIN_NO" }] as const;
    for (const event of playerEvents) {
      if (result.status !== "idle") throw new Error(`expected idle, got ${result.status}`);
      result = await runAgent(twentyQuestionsMachine, {
        snapshot: result.persist(),
        event,
        executors,
      });
    }

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.guess).toBe("a cat");
    expect(call).toBeGreaterThan(0);
  });
});
