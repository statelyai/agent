/**
 * Bounded plan execution (ReWOO-flavored) — a planner produces a typed step
 * list, an explicit index loop gathers evidence per step under a step budget,
 * and a solver composes the final answer from the accumulated evidence map.
 *
 * The point of the example is the budget: `MAX_STEPS` caps how many plan steps
 * the loop will run, and when the planner hands back more steps than the budget
 * allows, the run ends in `failed` — "I could not execute this plan" — instead
 * of quietly truncating the plan and dressing a partial answer up as `done`.
 * (Contrast deep-research, which fans out in parallel and *reflects* its way to
 * an answer; this one runs a fixed plan in order and can honestly run out.)
 *
 * Shows:
 *   - `planTask`: a structured-output request → a typed list of steps.
 *   - `executing`: the honest XState shape — an explicit `stepIndex` + a
 *     `choice` guard iterating the plan one step at a time (no hidden loop).
 *   - each step invokes `gatherEvidence` (a real model call) and records the
 *     result in `context.evidence` keyed by step id — that's the ReWOO bit:
 *     evidence is retained, not discarded between steps.
 *   - `solveTask`: composes the final answer from the whole evidence map.
 *
 * Readable output: the plan and the per-step progress trail are RENDERED in
 * `output` from the steps and the evidence map, never stored pre-rendered in
 * context. Full per-step evidence lives under the nested `details` field, so a
 * renderer that leads with the longest string field shows the
 * plan/progress/answer summary, not a wall of evidence prose.
 *
 * Bounded: the `executing` choice state is a three-way decision — gather the
 * next step, solve because the plan finished, or fail because the budget ran
 * out mid-plan. A request that errors also ends the run in `failed` rather than
 * quietly producing an empty answer.
 *
 * Dual-mode: `runPlanAndExecuteExample(options?)` takes injectable executors
 * (the test passes mocks — keyless CI); the direct run below uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/plan-and-execute/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent, type RunAgentOptions } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const stepSchema = z.object({ id: z.string(), question: z.string() });
const planSchema = z.object({ steps: z.array(stepSchema) });

export const models = defineModels({
  planner: openai("gpt-5.4-mini"),
  worker: openai("gpt-5.4-mini"),
  solver: openai("gpt-5.4-mini"),
});

/** Hard cap on plan steps the loop will run, whatever the planner returns. */
export const MAX_STEPS = 4;

const planAndExecuteContextSchema = z.object({
  goal: z.string(),
  steps: z.array(stepSchema),
  stepIndex: z.number(),
  evidence: z.record(z.string(), z.string()),
  answer: z.string().nullable(),
  /** Why the run gave up, when it did. `null` on the happy path. */
  failure: z.string().nullable(),
});

type PlanContext = z.infer<typeof planAndExecuteContextSchema>;

/** Collapses a model answer to a single short line for the progress trail. */
function oneLine(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The plan as the planner returned it, one line per step — derived from
 * `steps`, not stored. Steps past `MAX_STEPS` are marked rather than hidden, so
 * a plan that overran the budget is visible in the output that reports it.
 */
function renderPlan(context: PlanContext): string {
  return context.steps
    .map((step, index) =>
      index < MAX_STEPS
        ? `${step.id}. ${step.question}`
        : `${step.id}. ${step.question} (over budget)`,
    )
    .join("\n");
}

/**
 * One collapsed line per step the loop actually reached: `done` when the
 * evidence map has an entry for it, `skipped` when the worker errored.
 * Derived from the evidence map, so the trail can never drift from it.
 */
function renderProgress(context: PlanContext): string {
  return context.steps
    .slice(0, context.stepIndex)
    .map((step) =>
      step.id in context.evidence
        ? `${step.id}. done. ${oneLine(context.evidence[step.id]!)}`
        : `${step.id}. skipped. worker error`,
    )
    .join("\n");
}

const agentSetup = setupAgent({
  models,
  context: planAndExecuteContextSchema,
  input: z.object({ goal: z.string() }),
  // One leading human-readable string (plan + collapsed progress + answer);
  // the full evidence map stays nested so it never becomes the lead.
  output: z.object({
    summary: z.string(),
    details: z.object({
      answer: z.string(),
      steps: z.array(stepSchema),
      evidence: z.record(z.string(), z.string()),
    }),
  }),
  // solveTask always sets `answer` before `done` reads it — narrow it non-null there.
  states: {
    done: {
      schemas: { context: planAndExecuteContextSchema.extend({ answer: z.string() }) },
    },
  },
  requests: {
    planTask: {
      schemas: {
        input: z.object({ goal: z.string() }),
        output: planSchema,
      },
      model: "planner",
      system:
        "You are a planner. Break the goal into exactly 2 ordered research " +
        'sub-questions, each one short line. Give each a short id like "E1", "E2".',
      prompt: ({ input }) => input.goal,
    },
    gatherEvidence: {
      schemas: {
        input: z.object({ question: z.string() }),
        output: z.string(),
      },
      model: "worker",
      system:
        "You are a research worker. Answer the sub-question in at most two short " +
        "sentences of plain facts. No preamble, no lists.",
      prompt: ({ input }) => input.question,
    },
    solveTask: {
      schemas: {
        input: z.object({
          goal: z.string(),
          evidence: z.record(z.string(), z.string()),
        }),
        output: z.string(),
      },
      model: "solver",
      system:
        "You are a solver. Compose a final answer from the gathered evidence in " +
        "at most three sentences.",
      prompt: ({ input }) =>
        `Goal: ${input.goal}\n\nEvidence:\n${Object.entries(input.evidence)
          .map(([id, text]) => `${id}: ${text}`)
          .join("\n")}`,
    },
  },
});

export const planAndExecuteSchemas = agentSetup.schemas;

export const planAndExecuteMachine = agentSetup.createMachine({
  id: "plan-and-execute",
  context: ({ input }) => ({
    goal: input.goal,
    steps: [],
    stepIndex: 0,
    evidence: {},
    answer: null,
    failure: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        id: "planTask",
        src: "planTask",
        input: ({ context }) => ({ goal: context.goal }),
        onDone: ({ output }) => ({ target: "executing", context: { steps: output.steps } }),
        // A planner that errors ends the run in `failed` — an empty answer in
        // `done` would look like a successful run that had nothing to say.
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `planTask failed: ${String(event.error)}` },
        }),
      },
    },
    // Explicit index/guard loop with a THREE-way decision, which is the whole
    // point of this example: gather the next step, solve because the plan is
    // finished, or give up because the step budget ran out mid-plan.
    //
    // The budget is not a silent truncation. A planner that returns fifty steps
    // costs at most MAX_STEPS worker calls AND lands in `failed` — the run
    // never composes an answer from a plan it only partly executed and passes
    // it off as `done`.
    executing: {
      type: "choice",
      choice: ({ context }) => {
        if (context.stepIndex >= context.steps.length) {
          // Every planned step ran (or was skipped): the plan is complete.
          return { target: "solving" };
        }
        if (context.stepIndex >= MAX_STEPS) {
          // Budget exhausted with plan steps still unrun.
          return {
            target: "failed",
            context: {
              failure:
                `step budget exhausted: ran ${MAX_STEPS} of ${context.steps.length} ` +
                `planned steps (MAX_STEPS=${MAX_STEPS})`,
            },
          };
        }
        return { target: "gathering" };
      },
    },
    gathering: {
      invoke: {
        id: "gatherEvidence",
        src: "gatherEvidence",
        input: ({ context }) => ({
          question: context.steps[context.stepIndex]?.question ?? "",
        }),
        // The step's full evidence goes in the map; the progress trail only
        // gets one collapsed line, so the run stays readable as it grows.
        onDone: ({ context, output }) => {
          const id = context.steps[context.stepIndex]?.id ?? String(context.stepIndex);
          return {
            target: "executing",
            context: {
              stepIndex: context.stepIndex + 1,
              evidence: { ...context.evidence, [id]: output },
            },
          };
        },
        // On failure, skip the failed step (advance the index) and continue the
        // loop rather than retrying it forever. The absence of an evidence
        // entry is what marks the step skipped.
        onError: ({ context }) => ({
          target: "executing",
          context: { stepIndex: context.stepIndex + 1 },
        }),
      },
    },
    solving: {
      invoke: {
        id: "solveTask",
        src: "solveTask",
        input: ({ context }) => ({
          goal: context.goal,
          evidence: context.evidence,
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `solveTask failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: [
          "Plan",
          renderPlan(context) || "(no plan)",
          "",
          "Progress",
          renderProgress(context) || "(no steps run)",
          "",
          "Answer",
          context.answer,
        ].join("\n"),
        details: {
          answer: context.answer,
          steps: context.steps,
          evidence: context.evidence,
        },
      }),
    },
    // A distinct terminal for "the run could not produce an answer", so a
    // caller can tell an empty answer apart from a failed one.
    failed: {
      type: "final",
      output: ({ context }) => ({
        summary: [
          "Plan",
          renderPlan(context) || "(no plan)",
          "",
          "Progress",
          renderProgress(context) || "(no steps run)",
          "",
          "Failed",
          context.failure ?? "unknown failure",
        ].join("\n"),
        details: { answer: "", steps: context.steps, evidence: context.evidence },
      }),
    },
  },
});

export async function runPlanAndExecuteExample(
  options?: RunAgentOptions<typeof planAndExecuteMachine>,
) {
  const result = await runAgent(planAndExecuteMachine, {
    input: { goal: "Is a heat pump worth it for a 1920s house?" },
    executors: createAiSdkExecutors({ models }),
    ...options,
  });
  if (result.status !== "done") {
    throw new Error(`Plan-and-execute example did not complete: ${result.status}`);
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
    const output = await runPlanAndExecuteExample({
      executors: createAiSdkExecutors({ models }),
      onTransition: (snapshot) =>
        console.log(
          "[state]",
          JSON.stringify(snapshot.value),
          `step ${snapshot.context.stepIndex}/${snapshot.context.steps.length}`,
        ),
    });
    console.log(output.summary);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
