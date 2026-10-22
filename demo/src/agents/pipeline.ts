/**
 * Plan → execute → verify — three model calls, three separate states.
 *
 * What the MODEL owns: planning the work, writing the artifact, and judging
 * it against the request (a typed pass/fail plus notes).
 * What the MACHINE owns: what the verdict means. A draft reaches `complete`
 * only when the verifier passes it; a failed check ends in `rejected`, never
 * in `complete`. Each step is also its own state with its own `onError`, so a
 * failure in `verify` is a different, independently handled event from a
 * failure in `plan` — not one opaque prompt that either works or doesn't.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const pipelineContextSchema = z.object({
  task: z.string(),
  plan: z.string().nullable(),
  draft: z.string().nullable(),
  verification: z.string().nullable(),
  failedAt: z.string().nullable(),
});

const agentSetup = setupAgent({
  context: pipelineContextSchema,
  input: z.object({ task: z.string() }),
  output: z.object({
    plan: z.string(),
    draft: z.string(),
    verification: z.string(),
    /** True only on `complete`: the verifier passed the draft. */
    verified: z.boolean(),
    failedAt: z.string().nullable(),
  }),
  requests: {
    planTask: {
      schemas: { input: z.object({ task: z.string() }), output: z.string() },
      model: "planner",
      system:
        "Plan how to complete the writing task: audience, supplied facts, structure. Do not write the artifact yet.",
      prompt: ({ input }) => input.task,
    },
    executeTask: {
      schemas: { input: z.object({ task: z.string(), plan: z.string() }), output: z.string() },
      model: "writer",
      system:
        "Execute the plan and write the requested artifact using only supplied facts. Return only the artifact.",
      prompt: ({ input }) => `Task:\n${input.task}\n\nPlan:\n${input.plan}`,
    },
    verifyTask: {
      schemas: {
        input: z.object({ task: z.string(), draft: z.string() }),
        output: z.object({ passed: z.boolean(), notes: z.string() }),
      },
      model: "critic",
      system:
        "Verify the draft against the task. `passed` is false if the draft makes a claim the task does not support " +
        "or misses a requirement. `notes`: one or two sentences naming what you checked or what failed.",
      prompt: ({ input }) => `Task:\n${input.task}\n\nDraft:\n${input.draft}`,
    },
  },
  states: {
    executing: { schemas: { context: pipelineContextSchema.extend({ plan: z.string() }) } },
    verifying: {
      schemas: { context: pipelineContextSchema.extend({ plan: z.string(), draft: z.string() }) },
    },
  },
});

export const pipelineMachine = agentSetup.createMachine({
  id: "pipeline",
  context: ({ input }) => ({
    task: input.task,
    plan: null,
    draft: null,
    verification: null,
    failedAt: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "planTask",
        input: ({ context }) => ({ task: context.task }),
        onDone: { target: "executing", context: ({ output }) => ({ plan: output.result }) },
        onError: { target: "failed", context: { failedAt: "planning" } },
      },
    },
    executing: {
      invoke: {
        src: "executeTask",
        input: ({ context }) => ({ task: context.task, plan: context.plan }),
        onDone: { target: "verifying", context: ({ output }) => ({ draft: output.result }) },
        onError: { target: "failed", context: { failedAt: "executing" } },
      },
    },
    verifying: {
      invoke: {
        src: "verifyTask",
        input: ({ context }) => ({ task: context.task, draft: context.draft }),
        // The verdict is the model's; what it gates is the machine's. Both
        // targets stay visible in this expression.
        onDone: ({ output: { result } }) =>
          result.passed
            ? { target: "complete", context: { verification: `Passed. ${result.notes}` } }
            : { target: "rejected", context: { verification: `Rejected. ${result.notes}` } },
        onError: { target: "failed", context: { failedAt: "verifying" } },
      },
    },
    complete: {
      type: "final",
      output: ({ context }) => ({
        plan: context.plan ?? "",
        draft: context.draft ?? "",
        verification: context.verification ?? "",
        verified: true,
        failedAt: null,
      }),
    },
    // The draft exists but did not pass: kept for the human to read, never
    // reported as complete.
    rejected: {
      type: "final",
      output: ({ context }) => ({
        plan: context.plan ?? "",
        draft: context.draft ?? "",
        verification: context.verification ?? "",
        verified: false,
        failedAt: null,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        plan: context.plan ?? "",
        draft: context.draft ?? "",
        verification: context.verification ?? "",
        verified: false,
        failedAt: context.failedAt,
      }),
    },
  },
});
