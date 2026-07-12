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
 * Dual-mode: `runPlanAndExecuteExample(options?)` takes injectable executors
 * (the test passes mocks — keyless CI); the direct run below uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/plan-and-execute/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent, type RunAgentOptions } from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { resolveExecutors, runExampleMain } from "../helpers/main.js";

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
  answer: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: planAndExecuteContextSchema,
  input: z.object({ goal: z.string() }),
  output: z.object({
    steps: z.array(stepSchema),
    answer: z.string(),
    evidence: z.record(z.string(), z.string()),
  }),
  // solveTask always sets `answer` before `done` reads it — narrow it non-null there.
  states: {
    planning: {},
    executing: {},
    gathering: {},
    solving: {},
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
        "You are a planner. Break the goal into 2-3 ordered research sub-questions. " +
        'Give each a short id like "E1", "E2".',
      prompt: ({ input }) => input.goal,
    },
    gatherEvidence: {
      schemas: {
        input: z.object({ question: z.string() }),
        output: z.string(),
      },
      model: "worker",
      system: "You are a research worker. Answer the sub-question concisely with facts.",
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
      system: "You are a solver. Compose a final answer from the gathered evidence.",
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
          context: { steps: output.steps },
        }),
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
        onDone: ({ context, output }) => ({
          target: "executing",
          context: {
            stepIndex: context.stepIndex + 1,
            evidence: {
              ...context.evidence,
              [context.steps[context.stepIndex]?.id ?? String(context.stepIndex)]: output,
            },
          },
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
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        steps: context.steps,
        answer: context.answer,
        evidence: context.evidence,
      }),
    },
  },
});

export async function runPlanAndExecuteExample(
  options?: RunAgentOptions<typeof planAndExecuteMachine>,
) {
  const result = await runAgent(planAndExecuteMachine, {
    input: {
      goal: "Should a small team pick XState or a hand-rolled reducer for agent workflows?",
    },
    ...resolveExecutors(models, options),
  });
  if (result.status !== "done") {
    throw new Error(`Plan-and-execute example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
  const output = await runPlanAndExecuteExample({
    ...createAiSdkExecutors({ models }),
    onTransition: (snapshot) =>
      console.log(
        "[state]",
        JSON.stringify(snapshot.value),
        `step ${snapshot.context.stepIndex}/${snapshot.context.steps.length}`,
      ),
  });
  console.log("Plan:");
  for (const step of output.steps) {
    console.log(`  ${step.id}: ${step.question}`);
  }
  console.log("\nEvidence:");
  for (const [id, text] of Object.entries(output.evidence)) {
    console.log(`  ${id}: ${text}`);
  }
  console.log(`\nAnswer:\n${output.answer}`);
});
