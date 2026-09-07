import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import { createOpenAiExecutors } from "@statelyai/agent/openai";
import { triageMachine } from "../triage/index.js";
import { twentyQuestionsMachine } from "../twenty-questions/index.js";
import { jokeMachine } from "../joke/index.js";

// The adapter's own unit tests live in `src/openai/index.test.ts`. These cover
// the host end to end: real example machines driven by `createOpenAiExecutors`
// over a stubbed client, no network.
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
                  finish_reason: "stop",
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
                    finish_reason: "tool_calls",
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
                  finish_reason: "stop",
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
              // `stream_options.include_usage` makes OpenAI send usage last.
              yield {
                choices: [],
                usage: { prompt_tokens: 9, completion_tokens: 11, total_tokens: 20 },
              };
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
