/**
 * Independent model reviewers vote in parallel; machine policy counts votes.
 * Inspired by https://www.anthropic.com/engineering/building-effective-agents
 * A failed reviewer abstains. Fewer than two approvals requires human review.
 * Run without credentials: pnpm tsx examples/consensus-review/index.ts
 * Replace the scripted executor with any SDK executor; the machine stays intact.
 */
import { z } from "zod";
import {
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type RunAgentOptions,
} from "@statelyai/agent";

const vote = z.object({ approve: z.boolean(), reason: z.string() });
const reviewer = z.enum(["security", "reliability", "maintainability"]);
const agent = setupAgent({
  input: z.object({ patch: z.string() }),
  context: z.object({
    patch: z.string(),
    votes: z.array(vote.extend({ reviewer })),
    abstentions: z.array(reviewer),
  }),
  output: z.object({
    approved: z.boolean(),
    humanReviewed: z.boolean(),
    votes: z.array(vote.extend({ reviewer })),
    abstentions: z.array(reviewer),
  }),
  meta: interactionMetaSchema,
  events: { APPROVE: z.object({}), REJECT: z.object({}) },
  requests: {
    review: {
      schemas: { input: z.object({ patch: z.string(), reviewer }), output: vote },
      model: "reviewer",
      prompt: ({ input }) =>
        `Review this patch for ${input.reviewer}. Explain your vote.\n${input.patch}`,
    },
  },
});

export const consensusReviewMachine = agent.createMachine({
  id: "consensus-review",
  context: ({ input }) => ({ patch: input.patch, votes: [], abstentions: [] }),
  initial: "reviewing",
  states: {
    reviewing: {
      type: "parallel",
      states: {
        security: {
          initial: "working",
          states: {
            working: {
              invoke: {
                id: "security",
                src: "review",
                input: ({ context }) => ({ patch: context.patch, reviewer: "security" }),
                onDone: ({ context, output }) => ({
                  target: "done",
                  context: { votes: [...context.votes, { ...output, reviewer: "security" }] },
                }),
                onError: ({ context }) => ({
                  target: "done",
                  context: { abstentions: [...context.abstentions, "security"] },
                }),
              },
            },
            done: { type: "final" },
          },
        },
        reliability: {
          initial: "working",
          states: {
            working: {
              invoke: {
                id: "reliability",
                src: "review",
                input: ({ context }) => ({ patch: context.patch, reviewer: "reliability" }),
                onDone: ({ context, output }) => ({
                  target: "done",
                  context: { votes: [...context.votes, { ...output, reviewer: "reliability" }] },
                }),
                onError: ({ context }) => ({
                  target: "done",
                  context: { abstentions: [...context.abstentions, "reliability"] },
                }),
              },
            },
            done: { type: "final" },
          },
        },
        maintainability: {
          initial: "working",
          states: {
            working: {
              invoke: {
                id: "maintainability",
                src: "review",
                input: ({ context }) => ({ patch: context.patch, reviewer: "maintainability" }),
                onDone: ({ context, output }) => ({
                  target: "done",
                  context: {
                    votes: [...context.votes, { ...output, reviewer: "maintainability" }],
                  },
                }),
                onError: ({ context }) => ({
                  target: "done",
                  context: { abstentions: [...context.abstentions, "maintainability"] },
                }),
              },
            },
            done: { type: "final" },
          },
        },
      },
      onDone: { target: "counting" },
    },
    counting: {
      type: "choice",
      choice: ({ context }) => ({
        target: context.votes.filter((v) => v.approve).length >= 2 ? "accepted" : "humanReview",
      }),
    },
    humanReview: {
      meta: {
        interaction: {
          label: "Review the votes before accepting this patch.",
          events: { APPROVE: { label: "Accept patch" }, REJECT: { label: "Reject patch" } },
        },
      },
      on: { APPROVE: { target: "overridden" }, REJECT: { target: "rejected" } },
    },
    accepted: {
      type: "final",
      output: ({ context }) => ({
        approved: true,
        humanReviewed: false,
        votes: context.votes,
        abstentions: context.abstentions,
      }),
    },
    overridden: {
      type: "final",
      output: ({ context }) => ({
        approved: true,
        humanReviewed: true,
        votes: context.votes,
        abstentions: context.abstentions,
      }),
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({
        approved: false,
        humanReviewed: true,
        votes: context.votes,
        abstentions: context.abstentions,
      }),
    },
  },
});

export function runConsensusReviewExample(
  options?: RunAgentOptions<typeof consensusReviewMachine>,
) {
  return runAgent(consensusReviewMachine, {
    input: { patch: "Validate input before writing to the database." },
    executors: {
      generateText: async () => ({
        output: { approve: true, reason: "Scripted review; substitute a real model in your host." },
      }),
    },
    ...options,
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runConsensusReviewExample()
    .then((result) => console.log(result.status === "done" ? result.output : result.status))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
