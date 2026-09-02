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
 *   - `type: "choice"` states as explicit, named decision points: each gates a
 *     branch on structured request output and shows up as its own node in the
 *     Stately visualizer, keeping the branching logic separate from the states
 *     that invoke the requests.
 *   - Attempt tracking in context to bound the revision loop.
 *
 * Contrast with `ai-sdk-evaluator-optimizer`: that loops to *refine* output
 * toward higher quality and always returns its best attempt. Guardrails
 * *gate*: they can refuse before any answer exists, and they refuse to vouch
 * for an answer they could not verify.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/guardrails/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createAgentSchemas, runAgent, setupAgent } from "@statelyai/agent";

const models = defineModels({
  quick: openai("gpt-5.4-mini"),
});

/** Scope the input guardrail enforces. Hardcoded so input is just the question. */
const DEFAULT_TOPIC = "geography";

const guardrailsContextSchema = z.object({
  question: z.string(),
  topic: z.string().nullable(),
  answer: z.string().nullable(),
  reason: z.string(),
  critique: z.string(),
  revisions: z.number(),
  maxRevisions: z.number(),
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
  requests: {
    validateQuestion: {
      schemas: {
        input: z.object({ question: z.string(), topic: z.string().nullable() }),
        output: z.object({
          answerable: z.boolean(),
          inScope: z.boolean(),
          reason: z.string(),
        }),
      },
      model: "quick",
      system:
        "INPUT GUARDRAIL. You gate questions before any answer is generated. " +
        "Decide answerable=true only if the question has a definite factual answer " +
        "(not opinion, not nonsense, not a request for harmful content). " +
        "If a topic scope is given, decide inScope=true only if the question falls " +
        "within that topic; with no topic, inScope is always true. Give a short reason.",
      prompt: ({ input }) =>
        [
          `Question: ${input.question}`,
          input.topic ? `Allowed topic (scope): ${input.topic}` : "Allowed topic (scope): (none)",
          "Judge answerable and inScope.",
        ].join("\n"),
    },
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
    verifyAnswer: {
      schemas: {
        input: z.object({ question: z.string(), answer: z.string() }),
        output: z.object({ supported: z.boolean(), critique: z.string() }),
      },
      model: "quick",
      system:
        "OUTPUT GUARDRAIL. You verify whether an answer is supported and actually " +
        "answers the question. Set supported=true only if the answer is factually " +
        "correct and directly responsive. Otherwise supported=false with a critique " +
        "naming the specific problem (wrong, unsupported, evasive, or off-question).",
      prompt: ({ input }) =>
        [`Question: ${input.question}`, `Answer: ${input.answer}`, "Is the answer supported?"].join(
          "\n",
        ),
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
    maxRevisions: 1,
    validated: null,
    verified: null,
  }),
  output: ({ context }) => {
    // Derived from which final state we settled in: a supported answer is
    // `answered`; an answer that exists but was not verified is `unverified`;
    // no answer at all means the input guardrail refused it.
    const status = context.verified?.supported
      ? ("answered" as const)
      : context.answer
        ? ("unverified" as const)
        : ("refused" as const);
    return {
      status,
      answer: status === "answered" ? context.answer : null,
      reason: context.reason,
    };
  },
  initial: "validatingQuestion",
  states: {
    // Input guardrail: gate the question before any answer exists.
    validatingQuestion: {
      invoke: {
        src: "validateQuestion",
        input: ({ context }) => ({ question: context.question, topic: context.topic }),
        onDone: ({ output }) => ({
          target: "checkingQuestion",
          context: { validated: output },
        }),
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
          context: { answer: output.answer },
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
        onDone: ({ output }) => ({
          target: "checkingAnswer",
          context: { verified: output, critique: output.critique },
        }),
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
        // Unsupported: revise at most maxRevisions times, then flag.
        if (context.revisions < context.maxRevisions) {
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
            answer: output.answer,
            revisions: context.revisions + 1,
          },
        }),
        onError: {
          target: "unverified",
          context: { reason: "Revision step failed." },
        },
      },
    },
    answered: { type: "final" },
    refused: { type: "final" },
    unverified: { type: "final" },
  },
});

const executors = createAiSdkExecutors({ models });

export async function main() {
  const result = await runAgent(guardrailsMachine, {
    input: {
      question: "What is the capital of France?",
    },
    executors,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Guardrails did not complete: ${result.status}`);
  }

  console.log(result.output);
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
