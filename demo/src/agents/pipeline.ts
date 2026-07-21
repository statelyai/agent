/**
 * Plan → execute → verify — three model calls, three separate states.
 *
 * What the MODEL owns: planning the work, writing the artifact, and verifying
 * it against the request.
 * What the MACHINE owns: the sequence and, crucially, the failure boundaries.
 * Each step is its own state with its own `onError`, so a failure in `verify`
 * is a different, independently handled event from a failure in `plan` — not
 * one opaque prompt that either works or doesn't.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({
    task: z.string(),
    plan: z.string().nullable(),
    draft: z.string().nullable(),
    verification: z.string().nullable(),
    failedAt: z.string().nullable(),
  }),
  input: z.object({ task: z.string() }),
  output: z.object({
    plan: z.string(),
    draft: z.string(),
    verification: z.string(),
    failedAt: z.string().nullable(),
  }),
  requests: {
    planTask: {
      schemas: { input: z.object({ task: z.string() }), output: z.string() },
      model: "planner",
      system: "Plan how to complete the writing task: audience, supplied facts, structure. Do not write the artifact yet.",
      prompt: ({ input }) => input.task,
    },
    executeTask: {
      schemas: { input: z.object({ task: z.string(), plan: z.string() }), output: z.string() },
      model: "writer",
      system: "Execute the plan and write the requested artifact using only supplied facts. Return only the artifact.",
      prompt: ({ input }) => `Task:\n${input.task}\n\nPlan:\n${input.plan}`,
    },
    verifyTask: {
      schemas: { input: z.object({ task: z.string(), draft: z.string() }), output: z.string() },
      model: "critic",
      system: "Verify the draft against the task. Flag unsupported claims or missing requirements, then give a concise verdict.",
      prompt: ({ input }) => `Task:\n${input.task}\n\nDraft:\n${input.draft}`,
    },
  },
  states: {
    executing: { context: { plan: z.string() } },
    verifying: { context: { plan: z.string(), draft: z.string() } },
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
        onDone: { target: "executing", context: ({ output }) => ({ plan: output }) },
        onError: { target: "failed", context: { failedAt: "planning" } },
      },
    },
    executing: {
      invoke: {
        src: "executeTask",
        input: ({ context }) => ({ task: context.task, plan: context.plan }),
        onDone: { target: "verifying", context: ({ output }) => ({ draft: output }) },
        onError: { target: "failed", context: { failedAt: "executing" } },
      },
    },
    verifying: {
      invoke: {
        src: "verifyTask",
        input: ({ context }) => ({ task: context.task, draft: context.draft }),
        onDone: { target: "complete", context: ({ output }) => ({ verification: output }) },
        onError: { target: "failed", context: { failedAt: "verifying" } },
      },
    },
    complete: {
      type: "final",
      output: ({ context }) => ({
        plan: context.plan ?? "",
        draft: context.draft ?? "",
        verification: context.verification ?? "",
        failedAt: null,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        plan: context.plan ?? "",
        draft: context.draft ?? "",
        verification: context.verification ?? "",
        failedAt: context.failedAt,
      }),
    },
  },
});
