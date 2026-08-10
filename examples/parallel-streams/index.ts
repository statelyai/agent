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
 *   - a `laneSummary` recorded as each region finishes, so the final view keeps
 *     the completion order and elapsed time the live stream showed.
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

/** One finished stream: which lane, and how long it took from run start. */
const laneSchema = z.object({ name: z.string(), ms: z.number() });

type Lane = z.infer<typeof laneSchema>;

/** Completion order plus elapsed time, the part a final view usually drops. */
function renderLanes(lanes: Lane[]): string {
  return lanes
    .map((lane, index) => `${index + 1}. ${lane.name} — finished at +${lane.ms}ms`)
    .join("\n");
}

/** Append a lane at the moment it finishes, and re-render the summary. */
function completeLane(context: { startedAt: number; lanes: Lane[] }, name: string) {
  const lanes = [...context.lanes, { name, ms: Date.now() - context.startedAt }];
  return { lanes, laneSummary: renderLanes(lanes) };
}

const agentSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    analysis: z.string().nullable(),
    poem: z.string().nullable(),
    /** Run start, so each lane's elapsed time is measured here, not guessed. */
    startedAt: z.number(),
    lanes: z.array(laneSchema),
    laneSummary: z.string(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({
    summary: z.string(),
    analysis: z.string(),
    poem: z.string(),
    laneSummary: z.string(),
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
    startedAt: Date.now(),
    lanes: [],
    laneSummary: "",
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
    // Timing survives the run instead of scrolling by with the chunks.
    laneSummary: context.laneSummary,
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
              context: { analysis: output, ...completeLane(context, "analysis") },
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
            onDone: ({ context, output }) => ({
              target: "done",
              context: { poem: output, ...completeLane(context, "poem") },
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
    ...(options && Object.keys(options).length > 0
      ? options
      : { executors: createAiSdkExecutors({ models }) }),
  });

  if (result.status !== "done") {
    throw new Error(`Parallel streams example did not complete: ${result.status}`);
  }
  return { output: result.output, buffers };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { output, buffers } = await runParallelStreamsExample(undefined, (snapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
    );
    console.log("[thinker]\n" + buffers.thinker);
    console.log("\n[poet]\n" + buffers.poet);
    console.log("\n[lanes]\n" + output.laneSummary);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
