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
 *   - the completion ORDER of the two regions, recorded in context as each one
 *     finishes, and rendered into the output rather than kept as a pre-rendered
 *     string. Elapsed time is measured by the HOST, not stored in context:
 *     `Date.now()` in context would make every replay of the same run diverge.
 *
 * Dual-mode: `runParallelStreamsExample(options?)` takes injectable executors
 * (the test passes a mock `streamText` — keyless CI); the direct run below
 * streams two real generations concurrently and prints them tagged.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/parallel-streams/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent, type RunAgentOptions } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

export const models = defineModels({
  thinker: openai("gpt-5.4-mini"),
  poet: openai("gpt-5.4-mini"),
});

/** Completion order, the part a final view usually drops. Rendered in `output`. */
function renderLanes(lanes: string[]): string {
  return lanes.map((lane, index) => `${index + 1}. ${lane}`).join("\n");
}

const agentSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    analysis: z.string().nullable(),
    poem: z.string().nullable(),
    /** Lane names in the order their streams finished. Replay-stable. */
    lanes: z.array(z.string()),
    /** One entry per lane whose stream errored. */
    failures: z.array(z.string()),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({
    summary: z.string(),
    analysis: z.string(),
    poem: z.string(),
    laneSummary: z.string(),
    failures: z.array(z.string()),
  }),
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
  context: ({ input }) => ({
    topic: input.topic,
    analysis: null,
    poem: null,
    lanes: [],
    failures: [],
  }),
  output: ({ context }) => ({
    // A one-line manifest, NOT a second copy: the streamed text already reached
    // the caller chunk-by-chunk and is returned verbatim in `analysis`/`poem`.
    // Repeating it here would render each stream twice.
    summary:
      `Two streams completed for "${context.topic}": ` +
      `analysis (${(context.analysis ?? "").length} chars) and ` +
      `poem (${(context.poem ?? "").length} chars).`,
    analysis: context.analysis ?? "",
    poem: context.poem ?? "",
    // Completion order survives the run instead of scrolling by with the
    // chunks — derived here, never stored pre-rendered in context.
    laneSummary: renderLanes(context.lanes),
    failures: context.failures,
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
            onDone: ({ context, output }) => ({
              target: "done",
              context: { analysis: output, lanes: [...context.lanes, "analysis"] },
            }),
            // A region that fails still has to reach a final state, or the
            // parallel machine never completes.
            onError: ({ context, event }) => ({
              target: "failed",
              context: { failures: [...context.failures, `analysis: ${String(event.error)}`] },
            }),
          },
        },
        done: { type: "final" },
        failed: { type: "final" },
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
            onDone: ({ context, output }) => ({
              target: "done",
              context: { poem: output, lanes: [...context.lanes, "poem"] },
            }),
            onError: ({ context, event }) => ({
              target: "failed",
              context: { failures: [...context.failures, `poem: ${String(event.error)}`] },
            }),
          },
        },
        done: { type: "final" },
        failed: { type: "final" },
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
  // Wall-clock belongs to the HOST: the machine's context stays replay-stable,
  // and the timings still show how the two streams interleaved.
  const startedAt = Date.now();
  const lastChunkAt: Record<string, number> = {};

  const result = await runAgent(parallelStreamsMachine, {
    input: { topic: "state machines" },
    executors: createAiSdkExecutors({ models }),
    ...options,
    onChunk: (chunk, { request }) => {
      buffers[request.id] = (buffers[request.id] ?? "") + chunk;
      lastChunkAt[request.id] = Date.now() - startedAt;
    },
    onTransition: observe,
  });

  if (result.status !== "done") {
    throw new Error(`Parallel streams example did not complete: ${result.status}`);
  }
  return { output: result.output, buffers, lastChunkAt };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { output, buffers } = await runParallelStreamsExample({}, (snapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
    );
    console.log("[thinker]\n" + buffers.thinker);
    console.log("\n[poet]\n" + buffers.poet);
    console.log("\n[lanes, in completion order]\n" + output.laneSummary);
    if (output.failures.length > 0) console.log("\n[failures]\n" + output.failures.join("\n"));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
