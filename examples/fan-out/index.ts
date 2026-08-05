/**
 * Fan-out (map-reduce) — dynamic, runtime-decided parallelism. A planner model
 * generates a list of N subtopics (structured output), the machine fans out one
 * summary request PER subtopic (the N is not known until the planner returns),
 * and a reducer composes the N summaries into one digest.
 *
 * This is the LangGraph `Send`-style shape: N parallel branches decided at
 * runtime, each branch's state visible in the snapshot, results reduced. It is
 * built on XState dynamic spawn — `enq.spawn(logic, { id, input })` in a state
 * `entry`, once per subtopic — not a fixed `type: 'parallel'` region (that would
 * hard-code the branch count).
 *
 * The branch logic is spawned BY REFERENCE off `actors` — the action's
 * `actors.summarizeSubtopic` is the machine's post-`provide`
 * implementation, so `runAgent` has already wrapped it with the host executor
 * set. No `.withExecutor` pre-binding, no machine factory closing over an
 * executor: the planner, every spawned branch, and the reducer all resolve
 * through the ONE `executors` set passed to `runAgent`.
 *
 * Snapshot note: while branches are in flight, every branch is a live child on
 * `snapshot.children` (`branch-0..N-1`) and the persisted snapshot round-trips
 * them — the per-branch state is NOT opaque to the machine (the test asserts
 * this mid-flight).
 *
 * Shows:
 *   - `planning`: a structured-output request → a typed list of subtopics.
 *   - `fanningOut`: `entry` spawns one branch per subtopic — dynamic N.
 *   - `collecting`: an `xstate.done.actor` handler counts matching `actorId`s
 *     completions and keys each summary into `context.summaries`.
 *   - `reducing`: composes the digest from the whole summaries map.
 *
 * Dual-mode: `runFanOutExample(options?)` takes injectable executors (the test
 * passes mocks — keyless CI); the direct run below uses real models. One
 * `generateText` executor drives the planner, every branch, and the reducer.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/fan-out/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent, type RunAgentOptions } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const planSchema = z.object({ subtopics: z.array(z.string()) });

export const models = defineModels({
  planner: openai("gpt-5.4-mini"),
  worker: openai("gpt-5.4-mini"),
  reducer: openai("gpt-5.4-mini"),
});

const fanOutContextSchema = z.object({
  topic: z.string(),
  subtopics: z.array(z.string()),
  // reduced result map: branch id -> summary
  summaries: z.record(z.string(), z.string()),
  expected: z.number(),
  digest: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: fanOutContextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({
    digest: z.string(),
    subtopics: z.array(z.string()),
    summaries: z.record(z.string(), z.string()),
  }),
  // reducing always sets `digest` before `done` reads it — narrow it non-null there.
  // Every machine state must be declared here once any per-state schema is;
  // states without overrides declare `{}`.
  states: {
    planning: {},
    fanningOut: {},
    collecting: {},
    reducing: {},
    done: {
      schemas: { context: fanOutContextSchema.extend({ digest: z.string() }) },
    },
  },
  requests: {
    planSubtopics: {
      schemas: {
        input: z.object({ topic: z.string() }),
        output: planSchema,
      },
      model: "planner",
      system:
        "You are a planner. Break the topic into 3-5 distinct subtopics worth " +
        "summarizing. Return just the subtopic titles.",
      prompt: ({ input }) => input.topic,
    },
    // The fan-out branch: one summary per subtopic. Spawned dynamically off
    // `actors.summarizeSubtopic` — no pre-binding; `runAgent` binds it.
    summarizeSubtopic: {
      schemas: {
        input: z.object({ topic: z.string(), subtopic: z.string() }),
        output: z.string(),
      },
      model: "worker",
      system: "You are a research worker. Summarize the subtopic in 2-3 sentences.",
      prompt: ({ input }) => `Topic: ${input.topic}\nSubtopic: ${input.subtopic}`,
    },
    composeDigest: {
      schemas: {
        input: z.object({
          topic: z.string(),
          summaries: z.record(z.string(), z.string()),
        }),
        output: z.string(),
      },
      model: "reducer",
      system: "You are an editor. Compose one cohesive digest from the subtopic summaries.",
      prompt: ({ input }) =>
        `Topic: ${input.topic}\n\nSummaries:\n${Object.values(input.summaries)
          .map((text, i) => `${i + 1}. ${text}`)
          .join("\n")}`,
    },
  },
});

export const fanOutSchemas = agentSetup.schemas;

const BRANCH_PREFIX = "branch-";

/**
 * The fan-out machine. No factory, no pre-bound executor: the `fanningOut`
 * entry spawns `actors.summarizeSubtopic` — the machine's current (post-
 * `provide`) implementation, so `runAgent`'s host-bound executor reaches every
 * branch. The planner, branches, and reducer share ONE executor set, passed to
 * `runAgent({ executors })`.
 */
export const fanOutMachine = agentSetup.createMachine({
  id: "fan-out",
  context: ({ input }) => ({
    topic: input.topic,
    subtopics: [],
    summaries: {},
    expected: 0,
    digest: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        id: "planSubtopics",
        src: "planSubtopics",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "fanningOut",
          context: {
            subtopics: output.subtopics,
            expected: output.subtopics.length,
          },
        }),
      },
    },
    // DYNAMIC FAN-OUT: one spawn per subtopic — N decided at runtime from the
    // planner's output, not the machine config. `actors.summarizeSubtopic`
    // is the host-bound branch logic; each spawn is a live child
    // (`branch-0`..`branch-<N-1>`) visible on the snapshot until it completes.
    fanningOut: {
      entry: ({ context, actors }, enq) => {
        context.subtopics.forEach((subtopic, index) => {
          enq.spawn(actors.summarizeSubtopic, {
            id: `${BRANCH_PREFIX}${index}`,
            input: { topic: context.topic, subtopic },
          });
        });
      },
      always: { target: "collecting" },
    },
    // REDUCE: count every branch completion, keying its summary by branch id.
    // The canonical done event carries `actorId`, so one handler can observe N
    // dynamic children whose ids are only known at runtime.
    collecting: {
      on: {
        "xstate.done.actor": ({ context, event }) => {
          const id = (event as unknown as { actorId: string }).actorId;
          if (!id.startsWith(BRANCH_PREFIX)) {
            return undefined;
          }
          const summaries = {
            ...context.summaries,
            [id]: (event as unknown as { output: string }).output,
          };
          return Object.keys(summaries).length >= context.expected
            ? { target: "reducing", context: { summaries } }
            : { context: { summaries } };
        },
      },
    },
    reducing: {
      invoke: {
        id: "composeDigest",
        src: "composeDigest",
        input: ({ context }) => ({ topic: context.topic, summaries: context.summaries }),
        onDone: ({ output }) => ({ target: "done", context: { digest: output } }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        digest: context.digest,
        subtopics: context.subtopics,
        summaries: context.summaries,
      }),
    },
  },
});

/**
 * @deprecated The machine no longer needs a pre-bound executor — spawn resolves
 * the branch logic off `actors` and `runAgent` binds it. Use
 * `fanOutMachine` directly and pass `executors` to `runAgent`. The parameter is
 * ignored; kept for call-site compatibility.
 */
export function createFanOutMachine(_generateText?: unknown) {
  return fanOutMachine;
}

export async function runFanOutExample(
  options?: RunAgentOptions<typeof fanOutMachine>,
  observe?: RunAgentOptions<typeof fanOutMachine>["onTransition"],
) {
  const resolved =
    options && Object.keys(options).length > 0
      ? options
      : { executors: createAiSdkExecutors({ models }) };

  const result = await runAgent(fanOutMachine, {
    input: { topic: "How does an LLM agent framework stay durable?" },
    // `observe` is the direct-run narrator; a caller's own `onTransition`
    // (e.g. the test's mid-flight capture) in `resolved` takes precedence.
    onTransition: observe,
    ...resolved,
  });
  if (result.status !== "done") {
    throw new Error(`Fan-out example did not complete: ${result.status}`);
  }
  return result.output;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const output = await runFanOutExample(undefined, (snapshot) =>
      console.log(
        "[state]",
        JSON.stringify(snapshot.value),
        `${Object.keys(snapshot.context.summaries).length}/${snapshot.context.expected} branches done`,
      ),
    );
    console.log("Subtopics:");
    for (const subtopic of output.subtopics) {
      console.log(`  - ${subtopic}`);
    }
    console.log("\nSummaries:");
    for (const [id, text] of Object.entries(output.summaries)) {
      console.log(`  ${id}: ${text}`);
    }
    console.log(`\nDigest:\n${output.digest}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
