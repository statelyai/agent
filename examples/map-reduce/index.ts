/**
 * Map-reduce — split a topic into subjects, write one joke per subject in
 * parallel, then have a judge pick the best one.
 *
 * Ported from LangGraph's "How to create map-reduce branches for parallel
 * execution". There, `generate_topics` returns a list of subjects, a
 * conditional edge returns one `Send("generate_joke", {subject})` per subject
 * so the branches run in parallel, a list reducer (`operator.add`) collects
 * the jokes, and `best_joke` asks a model for the index of the best one. The
 * "orchestrator-worker" pattern in LangGraph's Workflows and Agents tutorial
 * is the same shape: a planner, a `Send` per section, a synthesizer.
 *
 * LangGraph shape:
 *
 *   START → generate_topics ─┬─ Send(generate_joke, s1) ─┐
 *                            ├─ Send(generate_joke, s2) ─┼─ best_joke → END
 *                            └─ Send(generate_joke, sN) ─┘
 *
 * Machine shape:
 *
 *   generatingSubjects → checkingSubjects ─┬─ generatingJokes ─┬─ judging → checkingJudgement ─┬─ done
 *                                          │                   │     ▲                         ├─ judging (retry once)
 *                                          │                   │     └─────────────────────────┘
 *                                          │                   │                               └─ failed
 *                                          │                   └─ done (one joke: nothing to judge)
 *                                          └─ failed (no subjects)
 *
 * What maps to what:
 *   - generate_topics            → `generatingSubjects`, a request with
 *                                  structured output `{ subjects: string[] }`
 *   - Send(...) per subject      → `generatingJokes` entry: `enq.spawn` of one
 *                                  `writeJoke` child per subject, N decided at runtime
 *   - operator.add reducer       → the `xstate.done.actor` handler, which adds
 *                                  `{ branch, subject, joke }` to `context.jokes` as each lands,
 *                                  and once all have settled routes to `judging`
 *                                  (two or more jokes) or straight to `done` (one)
 *   - best_joke                  → `judging`, ONE Jev `choice` over the jokes
 *                                  (see note)
 *   - the list index lookup      → `checkingJudgement`, a choice state that
 *                                  rejects a label the machine did not offer
 *
 * Differences from LangGraph worth calling out:
 *   - The fan-out width is bounded: more than `MAX_SUBJECTS` subjects are
 *     truncated (and `truncated` says so), zero subjects land in `failed`.
 *     LangGraph sends one branch per subject, however many come back.
 *   - A branch that errors records a placeholder joke and still counts as
 *     settled, so one broken writer cannot park the run. In LangGraph a
 *     failing `Send` branch fails the superstep.
 *   - Judging is a JUDGMENT, not a generation. LangGraph asks a chat model to
 *     write back an index. Here `judging` asks the AI SDK's
 *     `experimental_decide` with Jev (`@ai-sdk/typesafe-ai`) as the
 *     decision model, with the topic and every landed joke as state and one
 *     `choice` question whose labels are the jokes themselves (`joke0`,
 *     `joke1`, …, one per landed joke). `experimental_decide` rejects a label that was not
 *     offered, so an out-of-range or fractional index cannot happen by
 *     construction; the text model is reserved for the subjects and the jokes.
 *   - LangGraph indexes `state["jokes"][response.id]` directly; an index the
 *     model makes up raises. Here `checkingJudgement` still checks that the
 *     label names a joke that exists (a host could swap in any judge actor), retries
 *     `MAX_JUDGE_RETRIES` time(s), then the run ends in `failed` with every
 *     joke still in the output.
 *
 * No stand-ins: every node here is a model call. Branches finish in any
 * order, but each joke is kept in its branch's slot, so branch `joke-N`,
 * `jokes[N]`, trail line `[N]` and judge label `jokeN` all name the same joke.
 *
 * Dual-mode: `runMapReduceExample(options?)` takes an injectable
 * `generateText` and `judge` (tests script both); the direct run uses real
 * models.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/map-reduce/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_decide, type Experimental_DecisionModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  createTextLogic,
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
  type DoneActorEventOf,
} from "@statelyai/agent";

const models = {
  jokes: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's decision-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock decision model instead.
 */
const judgeModel: Experimental_DecisionModel = typeSafeAi.decisionModel("jev-latest");

/** Most subjects fanned out; extra subjects are dropped and `truncated` is set. */
export const MAX_SUBJECTS = 4;
/** Extra judging rounds after a label that names no joke, before `failed`. */
export const MAX_JUDGE_RETRIES = 1;

const BRANCH_PREFIX = "joke-";

/**
 * One map branch, as standalone logic so `generatingJokes` can spawn it per
 * subject. Its `name` is what scripted executors key on.
 */
export const writeJoke = createTextLogic({
  schemas: {
    input: z.object({ subject: z.string() }),
    output: z.object({ joke: z.string() }),
  },
  name: "writeJoke",
  model: "jokes",
  system: "Write one short, clean joke about the subject.",
  prompt: ({ input }) => `Subject: ${input.subject}`,
});

/** `branch` is N of the `joke-N` branch that wrote it, and its index in `jokes`. */
const jokeSchema = z.object({ branch: z.number(), subject: z.string(), joke: z.string() });
type Joke = z.infer<typeof jokeSchema>;

/** The label the judge answers with for the joke at `jokes[index]`. */
const jokeLabel = (index: number) => `joke${index}`;

/** The joke index a judge label names, or `null` for a label that names none. */
function labelIndex(label: string): number | null {
  const match = /^joke(\d+)$/.exec(label);
  return match ? Number(match[1]) : null;
}

/**
 * best_joke as a judgment: the topic and every landed joke are the state, and
 * one `choice` question offers one label per joke. The judge model is injected
 * by tests and hosts; the default is Jev.
 */
export function createJudgeJokes(model: Experimental_DecisionModel = judgeModel) {
  return createAsyncLogic<
    { answers: { best: { choice: string } } },
    { topic: string; jokes: Joke[] }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await experimental_decide({
        model,
        state: { topic: input.topic, jokes: input.jokes },
        questions: {
          best: {
            type: "choice" as const,
            instructions:
              "Which joke in `jokes` is the funniest take on `topic`? A `joke` in square " +
              "brackets is a placeholder for a writer that failed, never the funniest.",
            criteria: Object.fromEntries(
              input.jokes.map((entry, index) => [
                jokeLabel(index),
                `\`jokes[${index}]\`, the joke about "${entry.subject}".`,
              ]),
            ),
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

const contextSchema = z.object({
  topic: z.string(),
  subjects: z.array(z.string()),
  truncated: z.boolean(),
  /** The reduce target: one entry per settled branch, in branch order. */
  jokes: z.array(jokeSchema),
  judgeRetries: z.number().int(),
  bestIndex: z.number().nullable(),
  /** The one human-readable progress line. */
  notice: z.string(),
});
type MapReduceContext = z.infer<typeof contextSchema>;

/**
 * Reduce step: append a landed joke; move on once every branch has settled.
 * A lone joke is the best by default: a one-label `choice` is not a judgment,
 * so it skips `judging` and lands in `done` as index 0.
 */
function landJoke(context: MapReduceContext, entry: Joke) {
  // Kept in branch order, not arrival order: `jokes[N]` is branch `joke-N`.
  const jokes = [...context.jokes, entry].sort((left, right) => left.branch - right.branch);
  const next = {
    jokes,
    notice: `Wrote ${jokes.length} of ${context.subjects.length} jokes.`,
  };
  if (jokes.length < context.subjects.length) return { context: next };
  if (jokes.length === 1) {
    return {
      target: "done" as const,
      context: { jokes, bestIndex: 0, notice: "Only one joke; no judging needed." },
    };
  }
  return { target: "judging" as const, context: next };
}

function branchIndex(actorId: string): number {
  return Number(actorId.slice(BRANCH_PREFIX.length));
}

/** Rendered in `output`, never stored. */
function renderTrail(context: MapReduceContext): string[] {
  return [
    `Subjects: ${context.subjects.join(", ") || "(none)"}${context.truncated ? ` (truncated to ${MAX_SUBJECTS})` : ""}`,
    ...context.jokes.map((entry) => `[${entry.branch}] ${entry.subject}: ${entry.joke}`),
    context.notice,
  ];
}

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({
    bestJoke: z.string(),
    subject: z.string().nullable(),
    jokes: z.array(jokeSchema),
    trail: z.array(z.string()),
  }),
  actors: {
    writeJoke,
    // best_joke: a Jev choice over the landed jokes (see createJudgeJokes).
    judgeJokes: createJudgeJokes(),
  },
  requests: {
    generateSubjects: {
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.object({ subjects: z.array(z.string()) }),
      },
      model: "jokes",
      system: `List two to ${MAX_SUBJECTS} distinct subjects related to the topic, a few words each.`,
      prompt: ({ input }) => `Topic: ${input.topic}`,
    },
  },
});

export const mapReduceSchemas = agentSetup.schemas;

export const mapReduceMachine = agentSetup.createMachine({
  id: "map-reduce",
  context: ({ input }) => ({
    topic: input.topic,
    subjects: [],
    truncated: false,
    jokes: [],
    judgeRetries: 0,
    bestIndex: null,
    notice: "Listing subjects for the topic.",
  }),
  initial: "generatingSubjects",
  states: {
    generatingSubjects: {
      invoke: {
        src: "generateSubjects",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "checkingSubjects",
          context: {
            subjects: output.result.subjects
              .map((subject) => subject.trim())
              .filter((subject) => subject !== ""),
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { notice: `generateSubjects failed: ${String(event.error)}` },
        }),
      },
    },
    // Bound the fan-out before it happens: none → failed, too many → truncate.
    checkingSubjects: {
      type: "choice",
      choice: ({ context }) => {
        if (context.subjects.length === 0) {
          return { target: "failed", context: { notice: "The model listed no subjects." } };
        }
        if (context.subjects.length > MAX_SUBJECTS) {
          return {
            target: "generatingJokes",
            context: { subjects: context.subjects.slice(0, MAX_SUBJECTS), truncated: true },
          };
        }
        return { target: "generatingJokes" };
      },
    },
    // MAP: one `writeJoke` branch per subject (the `Send` fan-out). REDUCE: each
    // settled branch appends to `jokes`; an errored branch appends a
    // placeholder so the count still reaches the total.
    generatingJokes: {
      entry: ({ context, actors }, enq) => {
        context.subjects.forEach((subject, index) => {
          enq.spawn(actors.writeJoke, { id: `${BRANCH_PREFIX}${index}`, input: { subject } });
        });
      },
      on: {
        "xstate.done.actor": ({ context, event }) => {
          const { actorId, output } = event as DoneActorEventOf<typeof writeJoke>;
          if (!actorId.startsWith(BRANCH_PREFIX)) return undefined;
          const branch = branchIndex(actorId);
          const subject = context.subjects[branch] ?? actorId;
          // Trimmed: a trailing newline from the model would render as a blank
          // line inside the joke's list item.
          return landJoke(context, { branch, subject, joke: output.result.joke.trim() });
        },
        "xstate.error.actor": ({ context, event }) => {
          const { actorId } = event as unknown as { actorId: string };
          if (!actorId.startsWith(BRANCH_PREFIX)) return undefined;
          const branch = branchIndex(actorId);
          const subject = context.subjects[branch] ?? actorId;
          return landJoke(context, {
            branch,
            subject,
            joke: `[no joke: the writer for "${subject}" failed]`,
          });
        },
      },
    },
    judging: {
      invoke: {
        src: "judgeJokes",
        input: ({ context }) => ({ topic: context.topic, jokes: context.jokes }),
        onDone: ({ output }) => ({
          target: "checkingJudgement",
          context: { bestIndex: labelIndex(output.answers.best.choice) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { notice: `judgeJokes failed: ${String(event.error)}` },
        }),
      },
    },
    // The label must name a joke that exists. `experimental_decide` only returns offered
    // labels, so this guards a swapped-in judge actor: retry once, then give up with
    // every joke still in the output.
    checkingJudgement: {
      type: "choice",
      choice: ({ context }) => {
        if (
          context.bestIndex !== null &&
          Number.isInteger(context.bestIndex) &&
          context.bestIndex < context.jokes.length
        ) {
          return {
            target: "done",
            context: { notice: `The judge picked joke [${context.bestIndex}].` },
          };
        }
        if (context.judgeRetries < MAX_JUDGE_RETRIES) {
          return {
            target: "judging",
            context: {
              judgeRetries: context.judgeRetries + 1,
              notice: `The judge picked index ${context.bestIndex ?? "(no joke)"}, out of range; asking again.`,
            },
          };
        }
        return {
          target: "failed",
          context: {
            notice: `The judge picked index ${context.bestIndex ?? "(no joke)"} of ${context.jokes.length} jokes after ${MAX_JUDGE_RETRIES} retry.`,
          },
        };
      },
    },
    done: {
      type: "final",
      output: ({ context }) => {
        const best = context.jokes[context.bestIndex ?? 0];
        return {
          bestJoke: best?.joke ?? "",
          subject: best?.subject ?? null,
          jokes: context.jokes,
          trail: renderTrail(context),
        };
      },
    },
    // Best effort: no winner, but every joke that landed is returned.
    failed: {
      type: "final",
      output: ({ context }) => ({
        bestJoke: `No best joke: ${context.notice}`,
        subject: null,
        jokes: context.jokes,
        trail: renderTrail(context),
      }),
    },
  },
});

export interface RunMapReduceOptions {
  topic?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_DecisionModel;
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

/** Runs the map-reduce flow; `outcome` says which final state it reached. */
export async function runMapReduceExample(options: RunMapReduceOptions = {}) {
  const { topic = "animals", generateText, judge, onProgress } = options;

  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(mapReduceMachine, {
      ...(generateText
        ? { executors: { generateText } }
        : { executors: createAiSdkExecutors({ models }) }),
      ...(judge ? { actors: { judgeJokes: createJudgeJokes(judge) } } : {}),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { topic },
    },
  );

  if (result.status !== "done") {
    throw new Error(`Map-reduce example did not complete: ${result.status}`);
  }
  return { outcome: getStatePath(result.snapshot), ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void runMapReduceExample({ onProgress: (state) => console.log(`  → ${state}`) })
    .then(({ outcome, bestJoke, trail }) => {
      console.log(`\n[${outcome}] ${bestJoke}\n\n${trail.join("\n")}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
