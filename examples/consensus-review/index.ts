/**
 * Independent model reviewers vote in parallel; machine policy counts votes.
 * Inspired by https://www.anthropic.com/engineering/building-effective-agents
 * A failed reviewer abstains. Fewer than two approvals requires human review.
 * Run: OPENAI_API_KEY=... pnpm tsx examples/consensus-review/index.ts
 * The runner defaults to real AI SDK executors; pass `executors` to swap the
 * model layer (tests script it by request name). The machine stays intact.
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type RunAgentOptions,
} from "@statelyai/agent";

const vote = z.object({ approve: z.boolean(), reason: z.string() });
const reviewer = z.enum(["security", "reliability", "maintainability"]);
const models = {
  reviewer: openai("gpt-5.4-mini"),
};
const agent = setupAgent({
  models,
  // `source` is decided by host code, never by whoever supplied the patch: the
  // patch text reaches every reviewer prompt, so a patch the host did not
  // author is untrusted input and model votes cannot auto-accept it. There is
  // no default on purpose; a host has to say which it is.
  input: z.object({
    patch: z.string(),
    source: z.enum(["trusted", "external"]),
  }),
  context: z.object({
    patch: z.string(),
    source: z.enum(["trusted", "external"]),
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
  context: ({ input }) => ({
    patch: input.patch,
    source: input.source,
    votes: [],
    abstentions: [],
  }),
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
                  context: {
                    votes: [...context.votes, { ...output.result, reviewer: "security" }],
                  },
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
                  context: {
                    votes: [...context.votes, { ...output.result, reviewer: "reliability" }],
                  },
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
                    votes: [...context.votes, { ...output.result, reviewer: "maintainability" }],
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
      // An external patch always reaches a human: its text reaches every reviewer
      // prompt, so model votes on it are not a trust decision the machine honors.
      choice: ({ context }) => ({
        target:
          context.source === "trusted" && context.votes.filter((v) => v.approve).length >= 2
            ? "accepted"
            : "humanReview",
      }),
    },
    humanReview: {
      meta: {
        interaction: {
          label:
            "Review the votes before accepting this patch. Human review is required when the patch came from an external source, or when fewer than two reviewers approved.",
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

const BUILT_IN_PATCH = "Validate input before writing to the database.";

/** The host's real executors: one OpenAI model behind the `reviewer` ref. */
function liveExecutors() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the consensus-review example.");
  }
  return createAiSdkExecutors({ models });
}

/**
 * Runs the example. `source` is derived here, in host code, and cannot be
 * supplied by the caller: the built-in patch is the only trusted one, and any
 * patch passed in is `"external"`, so a caller cannot promote their own patch
 * to auto-acceptance by claiming it is trusted.
 */
export async function runConsensusReviewExample(
  options?: Omit<RunAgentOptions<typeof consensusReviewMachine>, "input"> & { patch?: string },
) {
  // `input` is stripped at runtime too, not only by the type: a caller passing
  // it through an untyped object must not be able to overwrite `source`.
  const {
    patch,
    input: _ignored,
    executors = liveExecutors(),
    ...runOptions
  } = (options ?? {}) as typeof options & {
    input?: unknown;
  };
  return runAgent(consensusReviewMachine, {
    ...runOptions,
    executors,
    // Last on purpose: the host-derived input wins over anything spread above.
    input:
      patch === undefined
        ? { patch: BUILT_IN_PATCH, source: "trusted" }
        : { patch, source: "external" },
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  runConsensusReviewExample()
    .then((result) => console.log(result.status === "done" ? result.output : result.status))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
