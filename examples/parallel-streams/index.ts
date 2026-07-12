/**
 * Parallel streams — two parallel states each run a `mode: 'stream'` request
 * concurrently, and `onChunk`'s `info.request.id` disambiguates the two
 * interleaved chunk streams.
 *
 * Shows:
 *   - a `type: 'parallel'` machine with two independent regions, each invoking
 *     a streaming text request (`thinker` and `poet`).
 *   - `runAgent`'s `onChunk(chunk, { request })` callback: because both streams
 *     land on the same callback, `request.id` (the invoke id) tells you which
 *     region a chunk belongs to.
 *
 * Dual-mode: `runParallelStreamsExample(options?)` takes injectable executors
 * (the test passes a mock `streamText` — keyless CI); the direct run below
 * streams two real generations concurrently and prints them tagged.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/parallel-streams/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent, type RunAgentOptions } from "../../src/index.js";
import { defineModels } from "../../src/ai-sdk/index.js";
import { resolveExecutors, runExampleMain } from "../helpers/main.js";

export const models = defineModels({
  thinker: openai("gpt-5.4-mini"),
  poet: openai("gpt-5.4-mini"),
});

const agentSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    analysis: z.string().nullable(),
    poem: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({ analysis: z.string(), poem: z.string() }),
  requests: {
    thinker: {
      mode: "stream",
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.string(),
      },
      model: "thinker",
      system: "You are an analyst. Give a short, structured analysis.",
      prompt: ({ input }) => `Analyze: ${input.topic}`,
    },
    poet: {
      mode: "stream",
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.string(),
      },
      model: "poet",
      system: "You are a poet. Write a short poem.",
      prompt: ({ input }) => `Write a short poem about: ${input.topic}`,
    },
  },
});

export const parallelStreamsSchemas = agentSetup.schemas;

export const parallelStreamsMachine = agentSetup.createMachine({
  id: "parallel-streams",
  context: ({ input }) => ({ topic: input.topic, analysis: null, poem: null }),
  output: ({ context }) => ({
    analysis: context.analysis ?? "",
    poem: context.poem ?? "",
  }),
  type: "parallel",
  states: {
    thinking: {
      initial: "active",
      states: {
        active: {
          invoke: {
            id: "thinker",
            src: "thinker",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: "done",
              context: { analysis: output },
            }),
          },
        },
        done: { type: "final" },
      },
    },
    versing: {
      initial: "active",
      states: {
        active: {
          invoke: {
            id: "poet",
            src: "poet",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: "done",
              context: { poem: output },
            }),
          },
        },
        done: { type: "final" },
      },
    },
  },
});

export async function runParallelStreamsExample(
  options?: RunAgentOptions<typeof parallelStreamsMachine>,
  observe?: RunAgentOptions<typeof parallelStreamsMachine>["onTransition"],
) {
  // Buffer chunks per stream, keyed by the invoke id — the disambiguator.
  const buffers: Record<string, string> = { thinker: "", poet: "" };

  const result = await runAgent(parallelStreamsMachine, {
    input: { topic: "state machines" },
    onChunk: (chunk, { request }) => {
      buffers[request.id] = (buffers[request.id] ?? "") + chunk;
    },
    onTransition: observe,
    ...resolveExecutors(models, options),
  });

  if (result.status !== "done") {
    throw new Error(`Parallel streams example did not complete: ${result.status}`);
  }
  return { output: result.output, buffers };
}

runExampleMain(import.meta.url, async () => {
  const { buffers } = await runParallelStreamsExample(undefined, (snapshot) =>
    console.log("[state]", JSON.stringify(snapshot.value)),
  );
  console.log("[thinker]\n" + buffers.thinker);
  console.log("\n[poet]\n" + buffers.poet);
});
