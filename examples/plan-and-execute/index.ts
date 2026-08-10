/**
 * Plan-and-execute (ReWOO-flavored) — a planner produces a typed step list,
 * an explicit index loop gathers evidence per step, and a solver composes the
 * final answer from the accumulated evidence map.
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
 * Readable output: the plan stays visible as a `plan` string and each finished
 * step collapses to ONE line appended to `progress`. Full per-step evidence
 * lives under the nested `details` field, so a renderer that leads with the
 * longest string field shows the plan/progress/answer summary, not a wall of
 * evidence prose.
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

const planAndExecuteContextSchema = z.object({
  goal: z.string(),
  steps: z.array(stepSchema),
  stepIndex: z.number(),
  evidence: z.record(z.string(), z.string()),
  // The plan, kept visible for the whole run: one line per step.
  plan: z.string(),
  // One collapsed line per finished step, appended as the loop runs.
  progress: z.string(),
  answer: z.string().nullable(),
});

/** Collapses a model answer to a single short line for the progress trail. */
function oneLine(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
      context: { answer: z.string() },
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
    plan: "",
    progress: "",
    answer: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        id: "planTask",
        src: "planTask",
        input: ({ context }) => ({ goal: context.goal }),
        onDone: ({ output }) => ({
          target: "executing",
          context: {
            steps: output.steps,
            // The plan is written once and stays visible for the whole run.
            plan: output.steps.map((step) => `${step.id}. ${step.question}`).join("\n"),
          },
        }),
        // On failure, finish with an empty answer (best-effort output).
        onError: { target: "done", context: { answer: "" } },
      },
    },
    // Explicit index/guard loop: gather evidence for one step, advance the
    // index, and re-check whether more steps remain. This is the honest
    // XState shape — no hidden iteration.
    executing: {
      type: "choice",
      choice: ({ context }) =>
        context.stepIndex < context.steps.length ? { target: "gathering" } : { target: "solving" },
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
              progress: `${context.progress}${id}. done. ${oneLine(output)}\n`,
            },
          };
        },
        // On failure, skip the failed step (advance the index) and continue the
        // loop rather than retrying it forever.
        onError: ({ context }) => {
          const id = context.steps[context.stepIndex]?.id ?? String(context.stepIndex);
          return {
            target: "executing",
            context: {
              stepIndex: context.stepIndex + 1,
              progress: `${context.progress}${id}. skipped. worker error\n`,
            },
          };
        },
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
        // On failure, finish with an empty answer (best-effort output).
        onError: { target: "done", context: { answer: "" } },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: [
          "Plan",
          context.plan || "(no plan)",
          "",
          "Progress",
          context.progress.trimEnd() || "(no steps run)",
          "",
          "Answer",
          context.answer || "(none)",
        ].join("\n"),
        details: {
          answer: context.answer,
          steps: context.steps,
          evidence: context.evidence,
        },
      }),
    },
  },
});

export async function runPlanAndExecuteExample(
  options?: RunAgentOptions<typeof planAndExecuteMachine>,
) {
  const result = await runAgent(planAndExecuteMachine, {
    input: { goal: "Is a heat pump worth it for a 1920s house?" },
    ...(options && Object.keys(options).length > 0
      ? options
      : { executors: createAiSdkExecutors({ models }) }),
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
