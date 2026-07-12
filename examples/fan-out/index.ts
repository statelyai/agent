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
 * hard-code the branch count; see `ai-sdk-parallel-review` for the static
 * counterpart). Each spawned branch is a pre-bound request logic
 * (`.withExecutor`), because spawned logics are not in any `invoke` config for
 * `runAgent`'s static bind walk to reach — so a branch carries its own executor.
 * That is why the machine is built by a factory over `generateText`: the
 * `entry` action closes over the pre-bound branch logic.
 *
 * Snapshot note: while branches are in flight, every branch is a live child on
 * `snapshot.children` (`branch-0..N-1`) and the persisted snapshot round-trips
 * them — the per-branch state is NOT opaque to the machine (the test asserts
 * this mid-flight). The one caveat: `runAgent`'s live-actor resume does not
 * re-run a spawned async child frozen mid-flight (same as any invoke on the
 * live path); a durable step host replays child-done events instead.
 *
 * Shows:
 *   - `planning`: a structured-output request → a typed list of subtopics.
 *   - `fanningOut`: `entry` spawns one branch per subtopic — dynamic N.
 *   - `collecting`: a wildcard `on` handler counts `xstate.done.actor.branch-*`
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
import {
  bindRequestExecutor,
  runAgent,
  setupAgent,
  type AgentRequestExecutor,
  type RunAgentOptions,
} from "../../src/index.js";
import { defineModels } from "../../src/ai-sdk/index.js";
import { resolveExecutors, runExampleMain } from "../helpers/main.js";

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
    subtopics: z.array(z.string()),
    summaries: z.record(z.string(), z.string()),
    digest: z.string(),
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
    // The fan-out branch: one summary per subtopic. Spawned dynamically, so it
    // is pre-bound with `.withExecutor` in the factory below.
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
 * Builds the fan-out machine, closing over the pre-bound branch logic. The
 * branch `.withExecutor` receives the already-built `request` (model, system,
 * prompt) and forwards it to `generateText`, so the planner, every branch, and
 * the reducer share ONE executor set.
 */
export function createFanOutMachine(generateText: AgentRequestExecutor) {
  const branchLogic = bindRequestExecutor(agentSetup.requests.summarizeSubtopic, generateText);

  return agentSetup.createMachine({
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
      // planner's output, not the machine config. Each branch is a live child
      // (`branch-0`..`branch-<N-1>`) visible on the snapshot until it completes.
      fanningOut: {
        entry: ({ context }, enq) => {
          context.subtopics.forEach((subtopic, index) => {
            enq.spawn(branchLogic, {
              id: `${BRANCH_PREFIX}${index}`,
              input: { topic: context.topic, subtopic },
            });
          });
        },
        always: { target: "collecting" },
      },
      // REDUCE: count every branch completion, keying its summary by branch id.
      // A wildcard handler is how the parent observes N dynamic children whose
      // ids are only known at runtime (no static `onDone` per branch).
      collecting: {
        on: {
          "*": ({ context, event }) => {
            const type = event.type as string;
            if (!type.startsWith(`xstate.done.actor.${BRANCH_PREFIX}`)) {
              return undefined;
            }
            const id = type.slice("xstate.done.actor.".length);
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
          subtopics: context.subtopics,
          summaries: context.summaries,
          digest: context.digest,
        }),
      },
    },
  });
}

export async function runFanOutExample(
  options?: RunAgentOptions<ReturnType<typeof createFanOutMachine>>,
  observe?: RunAgentOptions<ReturnType<typeof createFanOutMachine>>["onTransition"],
) {
  const executors = resolveExecutors(models, options);
  const generateText = executors.generateText;
  if (!generateText) {
    throw new Error("runFanOutExample requires a generateText executor.");
  }

  const machine = createFanOutMachine(generateText);
  const result = await runAgent(machine, {
    input: { topic: "How does an LLM agent framework stay durable?" },
    // `observe` is the direct-run narrator; a caller's own `onTransition`
    // (e.g. the test's mid-flight capture) in `executors` takes precedence.
    onTransition: observe,
    ...executors,
  });
  if (result.status !== "done") {
    throw new Error(`Fan-out example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
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
});
