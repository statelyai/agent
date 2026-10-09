/**
 * `createTanStackAiExecutors` against TanStack AI's real OpenAI adapter, with
 * only the network faked: a `fetch` that records each Responses API request
 * and answers with a scripted server-sent event stream. The library's own
 * tests use a hand-rolled text adapter; this checks what that fake cannot —
 * the option mapping as it reaches the wire, and the provider's own event
 * parsing on the way back.
 */
import { expect, test } from "vitest";
import { z } from "zod";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { createTanStackAiExecutors } from "@statelyai/agent/tanstack-ai";
import type { AgentDecisionRequest, AgentTextRequest, AgentTools } from "@statelyai/agent";

type ResponseEvent = { type: string; [key: string]: unknown };

const usage = {
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 4 },
  output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 15,
};

function response(status: string, output: unknown[] = []) {
  return { id: "resp_1", object: "response", created_at: 0, model: "gpt-5.4-mini", status, output };
}

/** The events of a Responses stream that answers with `text`. */
function textEvents(text: string): ResponseEvent[] {
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: response("in_progress") },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { ...response("completed", [message]), usage } },
  ];
}

/** The events of a Responses stream that answers with one function call. */
function functionCallEvents(name: string, args: unknown): ResponseEvent[] {
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  return [
    { type: "response.created", response: response("in_progress") },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: call.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      output_index: 0,
      arguments: call.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { ...response("completed", [call]), usage } },
  ];
}

/** A real OpenAI text adapter whose `fetch` answers each request from `script`. */
function scriptedOpenAi(
  script: ResponseEvent[][],
  model: "gpt-5.4-mini" | "gpt-4.1-mini" = "gpt-5.4-mini",
) {
  const requests: Record<string, any>[] = [];
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const events = script.shift() ?? [];
    const body = events
      .map((event, sequence) => {
        const data = JSON.stringify({ ...event, sequence_number: sequence });
        return `event: ${event.type}\ndata: ${data}\n\n`;
      })
      .join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const adapter = createOpenaiChat(model, "sk-test", { fetch, maxRetries: 0 });
  return { adapter, requests };
}

const textRequest = (overrides: Partial<AgentTextRequest> = {}) =>
  ({ model: "quick", prompt: "hi", tools: {}, ...overrides }) as AgentTextRequest & {
    tools: AgentTools;
  };

test("generation settings and the system prompt reach the Responses request", async () => {
  const { adapter, requests } = scriptedOpenAi([textEvents("Hello there")], "gpt-4.1-mini");
  const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

  const result = await generateText(
    textRequest({ system: "Be brief.", temperature: 0.2, topP: 0.9, maxOutputTokens: 64 }),
  );

  expect(requests[0]).toMatchObject({
    model: "gpt-4.1-mini",
    instructions: "Be brief.",
    temperature: 0.2,
    top_p: 0.9,
    max_output_tokens: 64,
  });
  expect(result.result).toBe("Hello there");
  expect(result.finishReason).toBe("stop");
  expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
});

test("a reasoning model drops the sampling settings it rejects", async () => {
  // TanStack AI's OpenAI adapter, not this one, removes them for gpt-5 models.
  const { adapter, requests } = scriptedOpenAi([textEvents("Hello there")]);
  const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

  await generateText(textRequest({ temperature: 0.2, topP: 0.9, maxOutputTokens: 64 }));

  expect(requests[0]).toMatchObject({ max_output_tokens: 64 });
  expect(requests[0]).not.toHaveProperty("temperature");
  expect(requests[0]).not.toHaveProperty("top_p");
});

test("structured output travels as a JSON schema and comes back parsed", async () => {
  const { adapter, requests } = scriptedOpenAi([
    textEvents(JSON.stringify({ result: { title: "Hi" } })),
  ]);
  const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

  const result = await generateText(textRequest({ outputSchema: z.object({ title: z.string() }) }));

  expect(requests[0]!.text?.format?.type).toBe("json_schema");
  expect(Object.keys(requests[0]!.text.format.schema.properties)).toEqual(["result"]);
  expect(result.result).toEqual({ title: "Hi" });
});

test("a decision forces a function call and reads the chosen event off the stream", async () => {
  const { adapter, requests } = scriptedOpenAi([functionCallEvents("approve", { note: "LGTM" })]);
  const { decide } = createTanStackAiExecutors({ models: { quick: adapter } });

  const result = await decide({
    model: "quick",
    prompt: "Approve or reject?",
    events: [
      { type: "APPROVE", toolName: "approve", inputSchema: z.object({ note: z.string() }) },
      { type: "REJECT", toolName: "reject" },
    ],
    attempts: [],
  } as unknown as AgentDecisionRequest);

  expect(requests[0]!.tool_choice).toBe("required");
  expect(requests[0]!.tools.map((tool: { name: string }) => tool.name)).toEqual([
    "approve",
    "reject",
  ]);
  expect(result.event).toEqual({ note: "LGTM", type: "APPROVE" });
  expect(result.finishReason).toBe("tool-calls");
});

test("a tool loop forces the tool on the first turn only, and returns the conversation", async () => {
  const { adapter, requests } = scriptedOpenAi([
    functionCallEvents("lookup", { city: "Oslo" }),
    textEvents("It is 20 degrees in Oslo."),
  ]);
  const { generateText } = createTanStackAiExecutors({ models: { quick: adapter } });

  const result = await generateText(
    textRequest({
      tools: {
        lookup: {
          description: "Look up the weather.",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }: { city: string }) => ({ city, temp: 20 }),
        },
      } as unknown as AgentTools,
      toolChoice: "required",
      maxSteps: 2,
    }),
  );

  expect(requests.map((request) => request.tool_choice)).toEqual(["required", undefined]);
  expect(requests[1]!.input).toContainEqual(
    expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
  );
  expect(result.result).toBe("It is 20 degrees in Oslo.");
  expect(result.messages.map((message) => message.role)).toEqual([
    "assistant",
    "tool",
    "assistant",
  ]);
  expect(result.usage).toMatchObject({ inputTokens: 24, outputTokens: 6, totalTokens: 30 });
});
