/**
 * Parallel research — two model calls run concurrently, then a synthesis.
 *
 * What the MODEL owns: three text generations (a risk analysis, an opportunity
 * analysis, and a final synthesis).
 * What the MACHINE owns: the fan-out/fan-in. `researching` is a `parallel`
 * state with two independent regions; `onDone` fires only once BOTH regions
 * reach their `final` state, so `synthesizing` is guaranteed to see both
 * analyses. No manual Promise.all, no ordering bugs — the statechart is the
 * concurrency.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({
    topic: z.string(),
    risks: z.string().nullable(),
    opportunities: z.string().nullable(),
    synthesis: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({ risks: z.string(), opportunities: z.string(), synthesis: z.string() }),
  requests: {
    researchRisks: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "analyst",
      system: "Analyze only the risks and downsides. State uncertainty. One concise paragraph.",
      prompt: ({ input }) => `Topic: ${input.topic}`,
    },
    researchOpportunities: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "analyst",
      system:
        "Analyze only the opportunities and upsides. State uncertainty. One concise paragraph.",
      prompt: ({ input }) => `Topic: ${input.topic}`,
    },
    synthesize: {
      schemas: {
        input: z.object({ topic: z.string(), risks: z.string(), opportunities: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: "Synthesize the two analyses into a concise, balanced recommendation.",
      prompt: ({ input }) =>
        `Topic: ${input.topic}\n\nRisks:\n${input.risks}\n\nOpportunities:\n${input.opportunities}`,
    },
  },
});

export const researchMachine = agentSetup.createMachine({
  id: "research",
  context: ({ input }) => ({
    topic: input.topic,
    risks: null,
    opportunities: null,
    synthesis: null,
  }),
  initial: "researching",
  states: {
    // Two regions run at the same time. onDone waits for both.
    researching: {
      type: "parallel",
      onDone: { target: "synthesizing" },
      states: {
        risk: {
          initial: "running",
          states: {
            running: {
              invoke: {
                src: "researchRisks",
                input: ({ context }) => ({ topic: context.topic }),
                onDone: { target: "done", context: ({ output }) => ({ risks: output }) },
              },
            },
            done: { type: "final" },
          },
        },
        opportunity: {
          initial: "running",
          states: {
            running: {
              invoke: {
                src: "researchOpportunities",
                input: ({ context }) => ({ topic: context.topic }),
                onDone: { target: "done", context: ({ output }) => ({ opportunities: output }) },
              },
            },
            done: { type: "final" },
          },
        },
      },
    },
    synthesizing: {
      invoke: {
        src: "synthesize",
        input: ({ context }) => ({
          topic: context.topic,
          risks: context.risks ?? "",
          opportunities: context.opportunities ?? "",
        }),
        onDone: { target: "complete", context: ({ output }) => ({ synthesis: output }) },
      },
    },
    complete: {
      type: "final",
      output: ({ context }) => ({
        risks: context.risks ?? "",
        opportunities: context.opportunities ?? "",
        synthesis: context.synthesis ?? "",
      }),
    },
  },
});
