/**
 * Guardrails — an input/output guardrail chain authored as explicit machine
 * states that GATE, rather than refine.
 *
 * Flow: validate the question → answer → verify the answer → revise-or-fail.
 * Showcases:
 *   - Input guardrail (refuse before generating): `validatingQuestion` checks
 *     whether the question is answerable and in scope. An out-of-scope or
 *     unanswerable question is refused in a `refused` final state — the
 *     `answer` request is never invoked at all.
 *   - Output guardrail (never silently return unsupported content):
 *     `verifyingAnswer` checks the answer against the question. An unsupported
 *     answer is revised at most once, then re-verified. A second failure ends
 *     in an `unverified` final state carrying the critique as the reason —
 *     the content is flagged, never returned as if trusted.
 *   - Both guardrails are JUDGMENTS, not generations. Each calls the AI SDK's
 *     `experimental_evaluate` with Jev (`@ai-sdk/typesafe-ai`) as the
 *     evaluation model, which answers boolean questions over explicit state: the input check asks "is the question answerable?" and "is it
 *     within the topic?" over `{ question, topic }`; the output check asks "is
 *     every claim correct?" and "does it answer the question?" over
 *     `{ question, answer }`. The machine compares each probability with an
 *     exported threshold (`INPUT_THRESHOLD`, `OUTPUT_THRESHOLD`) and renders
 *     the refusal reason and the critique from WHICH check failed. Only the
 *     answer and its revision stay text requests.
 *   - `type: "choice"` states as explicit, named decision points: each gates a
 *     branch on a guardrail's verdict and shows up as its own node in the
 *     Stately visualizer, keeping the branching logic separate from the states
 *     that invoke the requests.
 *   - A revision counter in context compared against the `MAX_REVISIONS`
 *     constant in the choice state, so the loop is bounded by the machine.
 *   - Three final states, each declaring its own `output`. The reported
 *     `status` IS the state the run settled in, not a flag re-derived from
 *     context afterwards.
 *
 * Contrast with `ai-sdk-evaluator-optimizer`: that loops to *refine* output
 * toward higher quality and always returns its best attempt. Guardrails
 * *gate*: they can refuse before any answer exists, and they refuse to vouch
 * for an answer they could not verify.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/guardrails/index.ts
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
} from "@statelyai/agent";

const models = {
  quick: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** Scope the input guardrail enforces. Hardcoded so input is just the question. */
const DEFAULT_TOPIC = "geography";

/** Bound on the revision loop: the counter lives in context, the limit here. */
const MAX_REVISIONS = 1;

/** The input guardrail passes a question only when both checks clear this. */
export const INPUT_THRESHOLD = 0.5;
/**
 * The output guardrail vouches for an answer only when both checks clear
 * this. Higher than the input bar: vouching for a wrong answer costs more than
 * one extra revision.
 */
export const OUTPUT_THRESHOLD = 0.7;

/**
 * Input guardrail as a judgment: two independent boolean questions over the
 * question and the allowed topic, in one `experimental_evaluate` call. The
 * judge model is injected by tests and hosts; the default is Jev.
 */
export function createValidateQuestion(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { answerable: { probability: number }; inScope: { probability: number } } },
    { question: string; topic: string | null }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { question: input.question, topic: input.topic ?? "(any topic)" },
        questions: {
          answerable: {
            type: "boolean" as const,
            instructions: "Does `question` have a definite factual answer?",
            criteria: {
              true: "A factual question with a checkable answer.",
              false: "An opinion, nonsense, a creative request, or a request for harmful content.",
            },
          },
          inScope: {
            type: "boolean" as const,
            instructions: "Is `question` about `topic`?",
            criteria: {
              true: "Answering it needs knowledge of the topic.",
              false: "It is about something else, even if it mentions a place or a name.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** Output guardrail as a judgment: correctness and responsiveness, one boolean question each. */
export function createVerifyAnswer(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { correct: { probability: number }; responsive: { probability: number } } },
    { question: string; answer: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { question: input.question, answer: input.answer },
        questions: {
          correct: {
            type: "boolean" as const,
            instructions: "Is every claim in `answer` factually correct?",
            criteria: {
              true: "Each statement is established fact.",
              false: "At least one statement is wrong, invented, or unsupported.",
            },
          },
          responsive: {
            type: "boolean" as const,
            instructions: "Does `answer` directly answer `question`?",
            criteria: {
              true: "It gives what the question asks for.",
              false: "It is evasive, partial, or answers a different question.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

const guardrailsContextSchema = z.object({
  question: z.string(),
  topic: z.string().nullable(),
  answer: z.string().nullable(),
  reason: z.string(),
  critique: z.string(),
  revisions: z.number(),
  validated: z
    .object({ answerable: z.boolean(), inScope: z.boolean(), reason: z.string() })
    .nullable(),
  verified: z.object({ supported: z.boolean(), critique: z.string() }).nullable(),
});

export const guardrailsSchemas = createAgentSchemas({
  context: guardrailsContextSchema,
  input: z.object({
    question: z.string(),
  }),
  output: z.object({
    status: z.enum(["answered", "refused", "unverified"]),
    answer: z.string().nullable(),
    reason: z.string(),
  }),
  events: {},
});

const agentSetup = setupAgent({
  schemas: guardrailsSchemas,
  models,
  // answering (and its retry, revising) always sets `answer` before either
  // state's request reads it — narrow it non-null there.
  states: {
    verifyingAnswer: {
      schemas: { context: guardrailsSchemas.context.extend({ answer: z.string() }) },
    },
    revising: {
      schemas: { context: guardrailsSchemas.context.extend({ answer: z.string() }) },
    },
  },
  actors: {
    // The two guardrails: Jev judgments (see createValidateQuestion / createVerifyAnswer).
    validateQuestion: createValidateQuestion(),
    verifyAnswer: createVerifyAnswer(),
  },
  requests: {
    answer: {
      schemas: {
        input: z.object({ question: z.string() }),
        output: z.object({ answer: z.string() }),
      },
      model: "quick",
      system:
        "ANSWER STEP. Answer the question concisely and factually. " +
        "Only assert what you are confident is true; do not invent specifics.",
      prompt: ({ input }) => `Question: ${input.question}`,
    },
    revise: {
      schemas: {
        input: z.object({ question: z.string(), answer: z.string(), critique: z.string() }),
        output: z.object({ answer: z.string() }),
      },
      model: "quick",
      system:
        "REVISION STEP. Rewrite the answer to fix the reviewer critique while staying " +
        "factual and directly responsive. If you cannot support a claim, drop it. " +
        "Return only the revised answer.",
      prompt: ({ input }) =>
        [
          `Question: ${input.question}`,
          `Previous answer: ${input.answer}`,
          `Critique: ${input.critique}`,
        ].join("\n"),
    },
  },
});

export const guardrailsMachine = agentSetup.createMachine({
  id: "guardrails",
  context: ({ input }) => ({
    question: input.question,
    topic: DEFAULT_TOPIC,
    answer: null,
    reason: "",
    critique: "",
    revisions: 0,
    validated: null,
    verified: null,
  }),
  initial: "validatingQuestion",
  states: {
    // Input guardrail: gate the question before any answer exists.
    validatingQuestion: {
      invoke: {
        src: "validateQuestion",
        input: ({ context }) => ({ question: context.question, topic: context.topic }),
        // The verdict, plus a reason rendered from whichever check failed.
        onDone: ({ context, output }) => {
          const answerable = output.answers.answerable.probability >= INPUT_THRESHOLD;
          const inScope = output.answers.inScope.probability >= INPUT_THRESHOLD;
          const reason = !answerable
            ? "Not a question with a definite factual answer."
            : !inScope
              ? `Not about ${context.topic ?? "the allowed topic"}.`
              : "Answerable and in scope.";
          return {
            target: "checkingQuestion",
            context: { validated: { answerable, inScope, reason } },
          };
        },
        onError: {
          target: "refused",
          context: { reason: "Input guardrail failed to run." },
        },
      },
    },
    checkingQuestion: {
      type: "choice",
      choice: ({ context }) =>
        context.validated && context.validated.answerable && context.validated.inScope
          ? { target: "answering" }
          : {
              target: "refused",
              context: {
                reason: context.validated?.reason ?? "Question was refused by the input guardrail.",
              },
            },
    },
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({
          target: "verifyingAnswer",
          context: { answer: output.result.answer },
        }),
        onError: {
          target: "refused",
          context: { reason: "Answer step failed." },
        },
      },
    },
    // Output guardrail: verify the answer against the question.
    verifyingAnswer: {
      invoke: {
        src: "verifyAnswer",
        input: ({ context }) => ({
          question: context.question,
          answer: context.answer,
        }),
        // The verdict, plus a critique for `revise` rendered from whichever
        // check failed.
        onDone: ({ output }) => {
          const correct = output.answers.correct.probability >= OUTPUT_THRESHOLD;
          const responsive = output.answers.responsive.probability >= OUTPUT_THRESHOLD;
          const critique = [
            correct ? "" : "The answer states something that is not established fact.",
            responsive ? "" : "The answer does not directly answer the question.",
          ]
            .filter(Boolean)
            .join(" ");
          const verified = { supported: correct && responsive, critique };
          return { target: "checkingAnswer", context: { verified, critique } };
        },
        onError: {
          target: "unverified",
          context: { reason: "Output guardrail failed to run." },
        },
      },
    },
    checkingAnswer: {
      type: "choice",
      choice: ({ context }) => {
        if (context.verified?.supported) {
          return {
            target: "answered",
            context: { reason: "Answer verified by the output guardrail." },
          };
        }
        // Unsupported: revise at most MAX_REVISIONS times, then flag.
        if (context.revisions < MAX_REVISIONS) {
          return { target: "revising" };
        }
        return {
          target: "unverified",
          context: {
            reason:
              "Answer could not be verified after revision: " +
              (context.critique || "unsupported."),
          },
        };
      },
    },
    revising: {
      invoke: {
        src: "revise",
        input: ({ context }) => ({
          question: context.question,
          answer: context.answer,
          critique: context.critique,
        }),
        onDone: ({ context, output }) => ({
          target: "verifyingAnswer",
          context: {
            answer: output.result.answer,
            revisions: context.revisions + 1,
          },
        }),
        onError: {
          target: "unverified",
          context: { reason: "Revision step failed." },
        },
      },
    },
    // The three outcomes each declare their own output, so `status` is the
    // final state the run settled in rather than a flag re-derived from
    // context afterwards. Only `answered` hands back the answer; `unverified`
    // flags it instead of returning content the guardrail could not vouch for.
    answered: {
      type: "final",
      output: ({ context }) => ({
        status: "answered" as const,
        answer: context.answer,
        reason: context.reason,
      }),
    },
    refused: {
      type: "final",
      output: ({ context }) => ({
        status: "refused" as const,
        answer: null,
        reason: context.reason,
      }),
    },
    unverified: {
      type: "final",
      output: ({ context }) => ({
        status: "unverified" as const,
        answer: null,
        reason: context.reason,
      }),
    },
  },
});

const executors = createAiSdkExecutors({ models });

export async function main() {
  const result = await runToQuiescence(
    createAgentRuntime(guardrailsMachine, {
      executors,
      onTransition: (snapshot) => console.log("[state]", getStatePath(snapshot)),
    }),
    {
      input: {
        question: "What is the capital of France?",
      },
    },
  );

  if (result.status !== "done") {
    throw new Error(`Guardrails did not complete: ${result.status}`);
  }

  console.log(result.output);
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
