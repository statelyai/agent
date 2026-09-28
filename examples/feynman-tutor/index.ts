/**
 * Feynman tutor — the "Chiron" Feynman-technique learning agent (a community
 * LangGraph tutorial) as a checkpoint loop with an explicit reteach budget.
 *
 * The idea: to learn a topic, split it into a few checkpoints. For each one,
 * the tutor sets the scene, the learner explains the idea back in their own
 * words, and a grader scores the explanation. A weak explanation gets a
 * simpler, Feynman-style re-teach and the learner tries again; a good one
 * moves on to the next checkpoint.
 *
 * LangGraph shape (NirDiamant/GenAI_Agents, chiron_learning_agent_langgraph):
 *
 *   START → generate_checkpoints → context_builder → user_answer (interrupt)
 *         → verify_answer ─┬─ (understood) → next_checkpoint ─┬─ context_builder …
 *                          │                                  └─ END
 *                          └─ (not yet) → teach_concept → user_answer …
 *
 * Here every node is a state, the conditional edges are `choice` states, and
 * the interrupt is an ordinary resting state the run settles idle on:
 *
 *   planningCheckpoints → checkingPlan ─┬─ failed (no checkpoints)
 *                                       └─ presenting → awaitingExplanation
 *   awaitingExplanation ─EXPLAIN→ verifying → grading ─┬─ (pass) advancing
 *                      │                              ├─ (budget left) teaching → awaitingExplanation
 *                      │                              └─ (budget spent) advancing   [checkpoint failed]
 *                      └─SKIP→ advancing              [checkpoint skipped]
 *   advancing ─┬─ presenting (next checkpoint)
 *              └─ done
 *
 * What maps to what:
 *   - generate_checkpoints → `planningCheckpoints` (request `planCheckpoints`),
 *                            capped at MAX_CHECKPOINTS by `checkingPlan`
 *   - context_builder      → `presenting` (request `introduceCheckpoint`)
 *   - user_answer interrupt→ `awaitingExplanation` (`meta.interaction`,
 *                            `textEvent: "EXPLAIN"`, plus a SKIP button)
 *   - verify_answer        → `verifying` (Jev judgment `verifyExplanation`: one
 *                            `score` question — see note below)
 *   - understanding check  → `grading` (a `choice` state on PASS_SCORE and MAX_RETEACHES)
 *   - teach_concept        → `teaching` (request `explainSimply`)
 *   - next_checkpoint      → `advancing` (a `choice` state on `checkpointIndex`)
 *   - checkpointer         → `result.persist()` between `runAgent` calls
 *
 * Differences from LangGraph worth calling out:
 *   - The reteach loop is bounded. Chiron loops teach → answer → verify until
 *     the learner gets it; here each checkpoint allows MAX_RETEACHES re-teaches,
 *     then the checkpoint is recorded as failed and the session moves on.
 *   - The pass/fail decision is a threshold the machine checks (PASS_SCORE),
 *     not a model's "understood: yes/no".
 *   - Grading is a JUDGMENT, not a generation. `verifying` asks the AI SDK's
 *     `experimental_evaluate`, with Jev (`@ai-sdk/typesafe-ai`) as the
 *     evaluation model, one `score` question over `{ checkpoint, keyIdea,
 *     explanation }` on five concrete levels (`UNDERSTANDING_LEVELS`), mapped
 *     to 0-100 in code as `score / (levels - 1) * 100`. The feedback the
 *     learner sees is the matched level's description; the text model is kept
 *     for what is generative: the plan, the intro, and the re-teach, which
 *     reads the learner's own attempt to address the specific gap.
 *   - The learner can SKIP a checkpoint — a real event, recorded in the output.
 *   - The number of checkpoints is capped (MAX_CHECKPOINTS) whatever the model
 *     returns, so a session has a known worst-case length.
 *   - Chiron's web search for checkpoint context is replaced by the model's
 *     own introduction; there is no retrieval step.
 *
 * Stand-ins: none. Every node is a model call or a Jev judgment; there is no
 * tool or search.
 *
 * Dual-mode: `runFeynmanTutorExample(options?)` takes an injectable
 * `generateText` and scripted human events (tests pass both, so CI needs no
 * API key); the direct run uses real models and stdin.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/feynman-tutor/index.ts
 */
import { z } from "zod";
import { createAsyncLogic, type SnapshotFrom } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  tutor: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** Most checkpoints a session covers, whatever the planner returns. */
export const MAX_CHECKPOINTS = 3;
/** Score (0-100) an explanation needs to pass a checkpoint. */
export const PASS_SCORE = 70;
/** Re-teaches allowed per checkpoint before it is recorded as failed. */
export const MAX_RETEACHES = 2;

const checkpointSchema = z.object({ title: z.string(), keyIdea: z.string() });

/** How well an explanation captures the key idea, lowest to highest. */
export const UNDERSTANDING_LEVELS = [
  'Does not address the key idea: off-topic, empty, or "I don\'t know".',
  "Mentions the topic but states the key idea wrongly, or confuses it with a different idea.",
  "Gets part of the key idea right but leaves out or misstates a central piece of it.",
  "States the key idea correctly in its own words, with a minor gap or imprecision.",
  "States the key idea correctly and completely in plain words, as if teaching it.",
] as const;

/**
 * verify_answer as a judgment: the checkpoint, its key idea and the learner's
 * explanation are the state, and one `score` question places the explanation
 * on `UNDERSTANDING_LEVELS`. The judge model is injected by tests and hosts;
 * the default is Jev.
 */
export function createVerifyExplanation(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { understanding: { score: number } } },
    { title: string; keyIdea: string; explanation: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { checkpoint: input.title, keyIdea: input.keyIdea, explanation: input.explanation },
        questions: {
          understanding: {
            type: "score" as const,
            instructions:
              "How well does `explanation` capture `keyIdea` for the checkpoint `checkpoint`? " +
              "Judge accuracy and completeness only, not style.",
            criteria: UNDERSTANDING_LEVELS,
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** The level on 0-100 and the matched level's description as feedback. */
function toVerdict(answer: { score: number }) {
  const top = UNDERSTANDING_LEVELS.length - 1;
  return {
    lastScore: Math.round((answer.score / top) * 100),
    lastFeedback: String(UNDERSTANDING_LEVELS[Math.round(answer.score)]),
  };
}

const resultSchema = z.object({
  title: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  /** Last score for the checkpoint; null when it was skipped before scoring. */
  score: z.number().nullable(),
  reteaches: z.number(),
});

type CheckpointResult = z.infer<typeof resultSchema>;

const feynmanContextSchema = z.object({
  topic: z.string(),
  checkpoints: z.array(checkpointSchema),
  checkpointIndex: z.number(),
  /** Re-teaches spent on the current checkpoint. */
  reteaches: z.number(),
  explanation: z.string(),
  lastScore: z.number().nullable(),
  lastFeedback: z.string(),
  results: z.array(resultSchema),
  /** What the idle state shows: the checkpoint intro, or the re-teach. */
  notice: z.string(),
  failure: z.string().nullable(),
});

type FeynmanContext = z.infer<typeof feynmanContextSchema>;

function currentCheckpoint(context: FeynmanContext) {
  return context.checkpoints[context.checkpointIndex] ?? { title: "", keyIdea: "" };
}

/** Records the current checkpoint's outcome and moves the index on. */
function recordAndAdvance(context: FeynmanContext, status: CheckpointResult["status"]) {
  return {
    results: [
      ...context.results,
      {
        title: currentCheckpoint(context).title,
        status,
        score: status === "skipped" ? null : context.lastScore,
        reteaches: context.reteaches,
      },
    ],
    checkpointIndex: context.checkpointIndex + 1,
    reteaches: 0,
    lastScore: null,
    lastFeedback: "",
  };
}

function renderSummary(context: FeynmanContext): string {
  const lines = context.results.map((result, index) => {
    const score = result.score === null ? "" : ` (score ${result.score}/100)`;
    const reteach = result.reteaches > 0 ? `, ${result.reteaches} re-teach(es)` : "";
    return `${index + 1}. ${result.title}: ${result.status}${score}${reteach}`;
  });
  const passed = context.results.filter((result) => result.status === "passed").length;
  return [
    `Feynman session on "${context.topic}": ${passed} of ${context.results.length} checkpoint(s) passed.`,
    ...lines,
  ].join("\n");
}

const outputSchema = z.object({
  summary: z.string(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  checkpoints: z.array(resultSchema),
});

function sessionOutput(context: FeynmanContext) {
  const count = (status: CheckpointResult["status"]) =>
    context.results.filter((result) => result.status === status).length;
  return {
    summary: context.failure
      ? `${context.failure}\n\n${renderSummary(context)}`
      : renderSummary(context),
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    checkpoints: context.results,
  };
}

const agentSetup = setupAgent({
  models,
  meta: interactionMetaSchema,
  context: feynmanContextSchema,
  input: z.object({ topic: z.string() }),
  output: outputSchema,
  events: {
    EXPLAIN: z.object({ text: z.string() }),
    SKIP: z.object({}),
  },
  // verify_answer: a Jev judgment (see createVerifyExplanation).
  actors: { verifyExplanation: createVerifyExplanation() },
  requests: {
    // generate_checkpoints: an ordered list of small learning goals.
    planCheckpoints: {
      schemas: {
        input: z.object({ topic: z.string(), max: z.number() }),
        output: z.object({ checkpoints: z.array(checkpointSchema) }),
      },
      model: "tutor",
      system:
        "You design Feynman-technique study sessions. Split the topic into a short, " +
        "ordered list of checkpoints, simplest first. Each has a title and the one key " +
        "idea a learner must be able to explain in plain words.",
      prompt: ({ input }) => `Topic: ${input.topic}\nAt most ${input.max} checkpoints.`,
    },
    // context_builder: set the scene for one checkpoint.
    introduceCheckpoint: {
      schemas: {
        input: z.object({ topic: z.string(), title: z.string(), keyIdea: z.string() }),
        output: z.object({ context: z.string() }),
      },
      model: "tutor",
      // The intro is shown to the learner as-is, so it talks to them ("you"),
      // not about them ("the learner should…").
      system:
        "Introduce one checkpoint of a study session in 3-5 sentences, speaking directly " +
        'to the learner as "you": why it matters and what you want them to understand. ' +
        'Never refer to "the learner" or "the student" in the third person. ' +
        "Do not quiz; they will explain it back to you next.",
      prompt: ({ input }) =>
        `Topic: ${input.topic}\nCheckpoint: ${input.title}\nKey idea: ${input.keyIdea}`,
    },
    // teach_concept: a simpler, analogy-first re-explanation.
    explainSimply: {
      schemas: {
        input: z.object({
          title: z.string(),
          keyIdea: z.string(),
          explanation: z.string(),
          feedback: z.string(),
        }),
        output: z.object({ explanation: z.string() }),
      },
      model: "tutor",
      system:
        "Re-teach a concept the Feynman way: plain words, one everyday analogy, no jargon. " +
        'Speak directly to the learner as "you", never "the learner" in the third person. ' +
        "Address the specific gap in their attempt. Keep it under 120 words.",
      prompt: ({ input }) =>
        [
          `Checkpoint: ${input.title}`,
          `Key idea: ${input.keyIdea}`,
          `Learner's attempt: ${input.explanation}`,
          `Grader feedback: ${input.feedback}`,
        ].join("\n"),
    },
  },
});

export const feynmanTutorSchemas = agentSetup.schemas;

export const feynmanTutorMachine = agentSetup.createMachine({
  id: "feynman-tutor",
  context: ({ input }) => ({
    topic: input.topic,
    checkpoints: [],
    checkpointIndex: 0,
    reteaches: 0,
    explanation: "",
    lastScore: null,
    lastFeedback: "",
    results: [],
    notice: "",
    failure: null,
  }),
  initial: "planningCheckpoints",
  states: {
    planningCheckpoints: {
      invoke: {
        src: "planCheckpoints",
        input: ({ context }) => ({ topic: context.topic, max: MAX_CHECKPOINTS }),
        onDone: ({ output }) => ({
          target: "checkingPlan",
          context: { checkpoints: output.result.checkpoints.slice(0, MAX_CHECKPOINTS) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `planCheckpoints failed: ${String(event.error)}` },
        }),
      },
    },
    checkingPlan: {
      type: "choice",
      choice: ({ context }) =>
        context.checkpoints.length === 0
          ? { target: "failed", context: { failure: "The planner returned no checkpoints." } }
          : { target: "presenting" },
    },
    // context_builder: the intro becomes the idle state's notice.
    presenting: {
      invoke: {
        src: "introduceCheckpoint",
        input: ({ context }) => ({ topic: context.topic, ...currentCheckpoint(context) }),
        onDone: ({ context, output }) => ({
          target: "awaitingExplanation",
          context: {
            notice:
              `Checkpoint ${context.checkpointIndex + 1}/${context.checkpoints.length}: ` +
              `${currentCheckpoint(context).title}\n\n${output.result.context}`,
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `introduceCheckpoint failed: ${String(event.error)}` },
        }),
      },
    },
    // The interrupt: the run settles idle here until the learner explains or skips.
    awaitingExplanation: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{notice}\n\nExplain this back in your own words.",
          textEvent: "EXPLAIN",
          events: {
            EXPLAIN: { label: "Submit explanation", style: "primary" },
            SKIP: { label: "Skip this checkpoint" },
          },
        },
      },
      on: {
        EXPLAIN: ({ event }) => ({ target: "verifying", context: { explanation: event.text } }),
        SKIP: ({ context }) => ({
          target: "advancing",
          context: recordAndAdvance(context, "skipped"),
        }),
      },
    },
    verifying: {
      invoke: {
        src: "verifyExplanation",
        input: ({ context }) => ({
          ...currentCheckpoint(context),
          explanation: context.explanation,
        }),
        onDone: ({ output }) => ({
          target: "grading",
          context: toVerdict(output.answers.understanding),
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `verifyExplanation failed: ${String(event.error)}` },
        }),
      },
    },
    // The understanding check: pass, re-teach while budget remains, else fail
    // this checkpoint and move on.
    grading: {
      type: "choice",
      choice: ({ context }) => {
        if ((context.lastScore ?? 0) >= PASS_SCORE) {
          return { target: "advancing", context: recordAndAdvance(context, "passed") };
        }
        if (context.reteaches < MAX_RETEACHES) return { target: "teaching" };
        return { target: "advancing", context: recordAndAdvance(context, "failed") };
      },
    },
    teaching: {
      invoke: {
        src: "explainSimply",
        input: ({ context }) => ({
          ...currentCheckpoint(context),
          explanation: context.explanation,
          feedback: context.lastFeedback,
        }),
        onDone: ({ context, output }) => ({
          target: "awaitingExplanation",
          context: {
            reteaches: context.reteaches + 1,
            notice:
              `Not yet (score ${context.lastScore ?? 0}/100, need ${PASS_SCORE}): ` +
              `${context.lastFeedback}\n\n${output.result.explanation}`,
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `explainSimply failed: ${String(event.error)}` },
        }),
      },
    },
    // next_checkpoint: more to cover, or the session is over.
    advancing: {
      type: "choice",
      choice: ({ context }) =>
        context.checkpointIndex < context.checkpoints.length
          ? { target: "presenting" }
          : { target: "done" },
    },
    done: {
      type: "final",
      output: ({ context }) => sessionOutput(context),
    },
    // Planning produced nothing, or a model call failed: the checkpoints
    // finished so far are the best-effort output.
    failed: {
      type: "final",
      output: ({ context }) => sessionOutput(context),
    },
  },
});

type FeynmanSnapshot = SnapshotFrom<typeof feynmanTutorMachine>;

/** What a host (or the test) sends to unblock the idle state. */
export type FeynmanHumanEvent = { type: "EXPLAIN"; text: string } | { type: "SKIP" };

export interface RunFeynmanTutorOptions {
  topic?: string;
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  /** Scripted learner events, consumed in order on each idle settle; then stdin. */
  humanEvents?: FeynmanHumanEvent[];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
  /** Observes the prompt shown on each idle settle. */
  onPrompt?: (label: string) => void;
}

export type FeynmanTutorResult = z.infer<typeof outputSchema> & {
  /** The final state reached: `done` or `failed`. */
  outcome: string;
  progress: string[];
};

/** Runs the session, resuming from `persist()` on every idle settle. */
export async function runFeynmanTutorExample(
  options: RunFeynmanTutorOptions = {},
): Promise<FeynmanTutorResult> {
  const {
    topic = "How public-key cryptography works",
    generateText,
    judge,
    onProgress,
    onPrompt,
  } = options;
  const queued = [...(options.humanEvents ?? [])];
  const progress: string[] = [];
  const shared = {
    executors: generateText ? { generateText } : createAiSdkExecutors({ models }),
    ...(judge ? { actors: { verifyExplanation: createVerifyExplanation(judge) } } : {}),
    onTransition: (snapshot: FeynmanSnapshot) => {
      const state = getStatePath(snapshot);
      // A resume re-reports the restored state; record each state once per visit.
      if (progress.at(-1) === state) return;
      progress.push(state);
      onProgress?.(state);
    },
  };

  let result = await runToQuiescence(
    createAgentRuntime(feynmanTutorMachine, {
      ...shared,
    }),
    {
      input: { topic },
      ...shared,
    },
  );
  while (result.status === "idle") {
    const label =
      getInteraction(result.snapshot, { preserveWhitespace: true })?.label ??
      result.snapshot.context.notice;
    onPrompt?.(label);
    const event = queued.shift() ?? toHumanEvent(await promptLine(`${label}\n(or "skip")\n> `));
    result = await runToQuiescence(
      createAgentRuntime(feynmanTutorMachine, {
        ...shared,
      }),
      {
        snapshot: result.persist(),
        event,
        ...shared,
      },
    );
  }

  if (result.status !== "done") {
    throw new Error(`Feynman tutor example did not complete: ${result.status}`);
  }
  return { ...result.output, outcome: getStatePath(result.snapshot), progress };
}

/** Typed "skip" skips the checkpoint; anything else is an explanation. */
export function toHumanEvent(text: string): FeynmanHumanEvent {
  return /^skip$/i.test(text.trim()) ? { type: "SKIP" } : { type: "EXPLAIN", text };
}

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runFeynmanTutorExample();
    console.log(`\n[${result.outcome}]\n`);
    console.log(result.summary);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
