import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { AgentDecisionRequest, AgentTextRequest } from "@statelyai/agent";
import { runAgent } from "@statelyai/agent";
import { getJsonSchema } from "@statelyai/agent";
import {
  createOpenAiExecutors,
  toDecisionMessages,
  toOpenAiCallSettings,
  toOpenAiEventTools,
  toOpenAiMessages,
  toOpenAiTools,
} from "./index.js";
import { triageMachine } from "../triage/index.js";
import { twentyQuestionsMachine } from "../twenty-questions/index.js";
import { jokeMachine } from "../joke/index.js";

describe("request -> OpenAI param mapping (pure helpers)", () => {
  test("toOpenAiMessages: system + prompt lower to a system + user message", () => {
    const messages = toOpenAiMessages({ system: "Be terse.", prompt: "Hi" });
    expect(messages).toEqual([
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

  test("toOpenAiCallSettings maps to max_completion_tokens, not max_tokens", () => {
    const settings = toOpenAiCallSettings({
      model: "gpt-5.4-mini",
      temperature: 0.5,
      maxOutputTokens: 100,
      topP: 0.9,
      seed: 42,
      stopSequences: ["END"],
    } as AgentTextRequest);
    expect(settings).toEqual({
      temperature: 0.5,
      max_completion_tokens: 100,
      top_p: 0.9,
      seed: 42,
      stop: ["END"],
    });
  });

  test("getJsonSchema reads the ~standard.jsonSchema extension when present", async () => {
    const schema = z.object({ sentiment: z.enum(["positive", "negative"]) });
    const jsonSchema = await getJsonSchema(schema);
    expect(jsonSchema).toMatchObject({ type: "object" });
  });

  test("getJsonSchema returns undefined for a schema without the extension", async () => {
    const bareSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    };
    expect(await getJsonSchema(bareSchema)).toBeUndefined();
  });

  test("getJsonSchema awaits a Promise-returning jsonSchema.input()", async () => {
    const asyncSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: async () => ({ type: "string" }),
        },
      },
    };
    expect(await getJsonSchema(asyncSchema)).toEqual({ type: "string" });
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
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.function.name)).toEqual(["send_event_ASK", "send_event_GUESS"]);
  });

  test("toDecisionMessages appends attempt feedback as user messages", () => {
    const request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts"> = {
      prompt: "Pick a move.",
      events: [{ type: "ASK", toolName: "send_event_ASK" }],
      attempts: [{ failure: "unknown-event", reason: "'FOO' is not allowed." }],
    };
    const messages = toDecisionMessages(request);
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("'FOO' is not allowed."),
    });
  });
});

describe("createOpenAiExecutors + runAgent (stubbed client, no network)", () => {
  test("generateText: structured output via response_format json_schema", async () => {
    const stubClient = {
      chat: {
        completions: {
          create: async (params: { response_format?: unknown }) => {
            expect(params.response_format).toMatchObject({ type: "json_schema" });
            // The host sends the `{ result }` envelope schema; the model replies
            // in kind. The host unwraps `.result` before the machine validates.
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      result: {
                        sentiment: "negative",
                        category: "billing",
                        reply: "Sorry about that — we will fix your invoice.",
                      },
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const { generateText } = createOpenAiExecutors({ client: stubClient as never });
    const result = await runAgent(triageMachine, {
      input: { ticket: "My invoice is wrong." },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // `done`'s output composes a `summary` string around the structured fields.
    expect(result.output).toMatchObject({
      sentiment: "negative",
      category: "billing",
      reply: "Sorry about that — we will fix your invoice.",
    });
    expect(result.output.summary).toContain("Sorry about that — we will fix your invoice.");
  });

  test("decide: tool_choice required, tool call maps back to a machine event", async () => {
    const stubClient = {
      chat: {
        completions: {
          create: async (params: { tool_choice?: unknown; tools?: unknown[] }) => {
            if (params.tool_choice === "required") {
              const guessTool = (params.tools as Array<{ function: { name: string } }>).find(
                (t) => t.function.name === "send_event_GUESS",
              );
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function",
                          function: {
                            name: guessTool!.function.name,
                            arguments: JSON.stringify({ guess: "a cat" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            }
            // classifyAnswer / classifyGuessFeedback / classifyPlayAgain text requests
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: "yes",
                      reasoning: "stub",
                      correct: true,
                      playAgain: false,
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const { generateText, decide } = createOpenAiExecutors({ client: stubClient as never });
    const executors = { generateText, decide };

    // The decide round-trip (tool_choice required → machine event) leaves the
    // run idle on a player turn; scripted button events resume it to done.
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
  });

  test("streamText: forwards chunks to onChunk and resolves with the full text", async () => {
    const chunks = ["Why", " did", " the", " state machine cross the road?"];
    const stubClient = {
      chat: {
        completions: {
          create: async () => ({
            [Symbol.asyncIterator]: async function* () {
              for (const chunk of chunks) {
                yield { choices: [{ delta: { content: chunk } }] };
              }
            },
          }),
        },
      },
    };

    const { streamText } = createOpenAiExecutors({ client: stubClient as never });
    // One entry per streamed joke: the machine always takes an improvement
    // pass, so the writer streams twice.
    const passes: string[][] = [];

    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: {
        generateText: async () => ({ output: { rating: 9, explanation: "stub" } }),
        streamText: async (request, info) => {
          const seen: string[] = [];
          passes.push(seen);
          return streamText(request, { ...info, onChunk: (chunk) => seen.push(chunk) });
        },
        decide: async () => ({ event: { type: "END" } }),
      },
    });

    expect(passes).toHaveLength(2);
    for (const seen of passes) {
      expect(seen.join("")).toBe(chunks.join(""));
    }
    expect(result.status).toBe("done");
  });
});
