import { describe, expect, test } from "vitest";
import { z } from "zod";
import type OpenAI from "openai";
import type { Snapshot } from "xstate";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { BaseTextAdapter, type StructuredOutputResult } from "@tanstack/ai/adapters";
import { createAgentRuntime, runToQuiescence, setupAgent } from "./index.js";
import { createOpenAiExecutors } from "./openai/index.js";
import { createTanStackAiExecutors } from "./tanstack-ai/index.js";

// The draft-and-score machine from docs/evals.md "Testing without a provider".
const emailAgent = setupAgent({
  input: z.object({ topic: z.string() }),
  context: z.object({ topic: z.string(), draft: z.string(), score: z.number().nullable() }),
  output: z.object({ draft: z.string(), score: z.number().nullable() }),
  requests: {
    draftEmail: {
      model: "writer",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      prompt: ({ input }) => `Write a short email about ${input.topic}.`,
    },
    scoreDraft: {
      model: "judge",
      schemas: {
        input: z.object({ draft: z.string() }),
        output: z.object({ score: z.number() }),
      },
      prompt: ({ input }) => `Score this email from 1 to 5:\n${input.draft}`,
    },
  },
});

const emailMachine = emailAgent.createMachine({
  context: ({ input }) => ({ topic: input.topic, draft: "", score: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "draftEmail",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "scoring", context: { draft: output.result } }),
      },
    },
    scoring: {
      invoke: {
        src: "scoreDraft",
        input: ({ context }) => ({ draft: context.draft }),
        onDone: ({ output }) => ({ target: "done", context: { score: output.result.score } }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ draft: context.draft, score: context.score }),
    },
  },
});

// docs/evals.md "### TanStack AI".
class FakeTextAdapter extends BaseTextAdapter<string, Record<string, any>, ["text"], any> {
  readonly name = "fake";

  constructor(private readonly text: string) {
    super({}, "fake-model");
  }

  async *chatStream(): AsyncIterable<StreamChunk> {
    const base = { model: this.model, timestamp: 0 };
    yield { type: EventType.RUN_STARTED, runId: "run", threadId: "t", ...base } as StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m",
      role: "assistant",
      ...base,
    } as StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m",
      delta: this.text,
      ...base,
    } as StreamChunk;
    yield { type: EventType.TEXT_MESSAGE_END, messageId: "m", ...base } as StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: "run",
      threadId: "t",
      finishReason: "stop",
      ...base,
    } as StreamChunk;
  }

  async structuredOutput(): Promise<StructuredOutputResult<unknown>> {
    return { data: JSON.parse(this.text), rawText: this.text };
  }
}

describe("documentation integration recipes", () => {
  test("an app can store an opaque snapshot and resume it with an event", async () => {
    const agent = setupAgent({
      context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ answer: z.string() }),
      events: { ANSWER: z.object({ answer: z.string() }) },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, answer: null }),
      initial: "waiting",
      states: {
        waiting: {
          on: {
            ANSWER: ({ event }) => ({
              target: "done",
              context: { answer: event.answer },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({
            answer: `${context.prompt}: ${context.answer}`,
          }),
        },
      },
    });

    async function startGeneration(input: { prompt: string }): Promise<{ snapshot: unknown }> {
      const result = await runToQuiescence(createAgentRuntime(machine), { input });
      if (result.status !== "idle") throw new Error(`Expected idle, got ${result.status}`);
      return { snapshot: result.persist() };
    }

    async function resumeGeneration(snapshot: unknown, answer: string): Promise<string> {
      const result = await runToQuiescence(createAgentRuntime(machine), {
        snapshot: snapshot as Snapshot<unknown>,
        event: { type: "ANSWER", answer },
      });
      if (result.status !== "done") throw new Error(`Expected done, got ${result.status}`);
      return result.output.answer;
    }

    const stored = JSON.parse(JSON.stringify(await startGeneration({ prompt: "Ship" })));
    await expect(resumeGeneration(stored.snapshot, "Approved")).resolves.toBe("Ship: Approved");
  });

  test("a stubbed OpenAI client runs the machine through createOpenAiExecutors", async () => {
    const answers: Record<string, string> = {
      writer: "Checkout now supports saved cards.",
      judge: JSON.stringify({ result: { score: 4 } }),
    };
    const calls: string[] = [];
    const client = {
      chat: {
        completions: {
          create: async (params: { model: string }) => {
            calls.push(params.model);
            const content = answers[params.model] ?? "";
            return {
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content, refusal: null },
                  finish_reason: "stop",
                },
              ],
            };
          },
        },
      },
    } as unknown as OpenAI;

    const result = await runToQuiescence(
      createAgentRuntime(emailMachine, { executors: createOpenAiExecutors({ client }) }),
      { input: { topic: "saved cards at checkout" } },
    );

    expect(result.status === "done" && result.output).toEqual({
      draft: "Checkout now supports saved cards.",
      score: 4,
    });
    expect(calls).toEqual(["writer", "judge"]);
  });

  test("a fake TanStack AI text adapter runs the machine through createTanStackAiExecutors", async () => {
    const result = await runToQuiescence(
      createAgentRuntime(emailMachine, {
        executors: createTanStackAiExecutors({
          models: {
            writer: new FakeTextAdapter("Checkout now supports saved cards."),
            judge: new FakeTextAdapter(JSON.stringify({ result: { score: 4 } })),
          },
        }),
      }),
      { input: { topic: "saved cards at checkout" } },
    );

    expect(result.status === "done" && result.output).toEqual({
      draft: "Checkout now supports saved cards.",
      score: 4,
    });
  });

  test("parallel requests route on info.requestId, which encodes the state path", async () => {
    const agent = setupAgent({
      context: z.object({ pros: z.string(), cons: z.string() }),
      output: z.object({ pros: z.string(), cons: z.string() }),
      requests: {
        summarize: {
          model: "quick",
          schemas: { input: z.object({ side: z.string() }), output: z.string() },
          prompt: ({ input }) => `List the ${input.side} of saved cards at checkout.`,
        },
      },
    });
    const reviewMachine = agent.createMachine({
      context: { pros: "", cons: "" },
      type: "parallel",
      states: {
        pros: {
          initial: "summarizing",
          states: {
            summarizing: {
              invoke: {
                src: "summarize",
                input: { side: "pros" },
                onDone: ({ output }) => ({ target: "done", context: { pros: output.result } }),
              },
            },
            done: { type: "final" },
          },
        },
        cons: {
          initial: "summarizing",
          states: {
            summarizing: {
              invoke: {
                src: "summarize",
                input: { side: "cons" },
                onDone: ({ output }) => ({ target: "done", context: { cons: output.result } }),
              },
            },
            done: { type: "final" },
          },
        },
      },
      output: ({ context }) => context,
    });

    const answers: Record<string, string> = {
      "0.(machine).pros.summarizing": "Faster repeat purchases.",
      "0.(machine).cons.summarizing": "Stored card data to secure.",
    };
    const inputs: unknown[] = [];
    const result = await runToQuiescence(
      createAgentRuntime(reviewMachine, {
        executors: {
          generateText: async (request, info) => {
            inputs.push(request.input);
            const answer = answers[info?.requestId ?? ""];
            if (answer === undefined) throw new Error(`No answer for ${info?.requestId}`);
            return { result: answer };
          },
        },
      }),
      {},
    );

    expect(result.status === "done" && result.output).toEqual({
      pros: "Faster repeat purchases.",
      cons: "Stored card data to secure.",
    });
    expect(inputs).toEqual(expect.arrayContaining([{ side: "pros" }, { side: "cons" }]));
  });
});
