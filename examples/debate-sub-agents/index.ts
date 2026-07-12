/**
 * Debate sub-agents — a neutral facilitator schedules two debater sub-agents
 * (affirmative + negative), each a child agent machine invoked as one actor.
 * The facilitator alternates turns (A, B, A, B, …) over `rounds` rounds,
 * requesting one argument per turn via a typed event, collects the transcript,
 * then runs a `concludeDebate` request that summarizes both sides.
 *
 * Authored the way the rest of the repo does it:
 *   - each debater is a child machine (like examples/subflows) with its own
 *     `composeArgument` request carrying its own stance-specific system prompt;
 *   - the parent invokes it by name under `actorSources` and schedules turns
 *     with events (like examples/supervisor dispatches specialists);
 *   - the whole thing runs via `runAgent`, not a raw `createActor`.
 *
 * Dual-mode: `runDebateSubAgentsExample(options?)` takes an injectable
 * `generateText` executor (the test passes a mock — keyless CI); the direct
 * run below uses real models via `createAiSdkExecutors` + `openai(...)`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/debate-sub-agents/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import {
  bindRequestExecutor,
  runAgent,
  setupAgent,
  type AgentRequestExecutor,
} from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

const stanceSchema = z.enum(["affirmative", "negative"]);
const transcriptEntrySchema = z.object({
  stance: stanceSchema,
  round: z.number(),
  text: z.string(),
});
const transcriptSchema = z.array(transcriptEntrySchema);

const DEFAULT_ROUNDS = 3;

export const models = defineModels({
  affirmative: openai("gpt-5.4-mini"),
  negative: openai("gpt-5.4-mini"),
  facilitator: openai("gpt-5.4-mini"),
});

// ─── Child agent: one debater arguing a fixed stance ───
const debaterAgentSetup = setupAgent({
  models,
  context: z.object({
    stance: stanceSchema,
    question: z.string(),
    round: z.number(),
    transcript: transcriptSchema,
  }),
  input: z.object({ stance: stanceSchema, question: z.string() }),
  events: {
    "DEBATE.ARGUMENT_REQUESTED": z.object({
      round: z.number(),
      transcript: transcriptSchema,
    }),
  },
  requests: {
    composeArgument: {
      schemas: {
        input: z.object({
          stance: stanceSchema,
          question: z.string(),
          round: z.number(),
          transcript: transcriptSchema,
        }),
        output: z.string(),
      },
      // The stance drives the model ref, so each debater's turn is attributed
      // to its own model in traces and mocks.
      model: ({ input }) => input.stance,
      system: ({ input }) =>
        `You argue the ${input.stance} side of the debate. Be concise (2-3 sentences) ` +
        `and directly rebut the opposing points made so far.`,
      prompt: ({ input }) =>
        [
          `Question: ${input.question}`,
          `Round: ${input.round}`,
          `Transcript so far: ${JSON.stringify(input.transcript)}`,
        ].join("\n"),
    },
  },
});

export const debaterMachine = debaterAgentSetup.createMachine({
  id: "debater",
  context: ({ input }) => ({
    stance: input.stance,
    question: input.question,
    round: 0,
    transcript: [],
  }),
  initial: "idle",
  states: {
    idle: {
      on: {
        "DEBATE.ARGUMENT_REQUESTED": ({ event }) => ({
          target: "composing",
          context: { round: event.round, transcript: event.transcript },
        }),
      },
    },
    composing: {
      invoke: {
        id: "composeArgument",
        src: "composeArgument",
        input: ({ context }) => ({
          stance: context.stance,
          question: context.question,
          round: context.round,
          transcript: context.transcript,
        }),
        onDone: ({ context, output, parent }, enq) => {
          if (parent) {
            enq.sendTo(parent, {
              type: "DEBATE.ARGUMENT_SUBMITTED",
              stance: context.stance,
              round: context.round,
              text: output,
            });
          }
          return { target: "idle" };
        },
      },
    },
  },
});

// ─── Facilitator agent: schedule A/B turns, then conclude ───
const facilitatorContextSchema = z.object({
  question: z.string(),
  rounds: z.number(),
  transcript: transcriptSchema,
  conclusion: z.string().nullable(),
});

const facilitatorAgentSetup = setupAgent({
  context: facilitatorContextSchema,
  input: z.object({ question: z.string(), rounds: z.number().default(DEFAULT_ROUNDS) }),
  output: z.object({ conclusion: z.string(), transcript: transcriptSchema }),
  events: { "DEBATE.ARGUMENT_SUBMITTED": transcriptEntrySchema },
  actorSources: { affirmative: debaterMachine, negative: debaterMachine },
  // concluding's onDone is the only transition into "done" and always sets
  // conclusion — narrow it non-null there.
  states: {
    requesting: {},
    awaiting: {},
    concluding: {},
    done: {
      schemas: { context: facilitatorContextSchema.extend({ conclusion: z.string() }) },
    },
  },
  requests: {
    concludeDebate: {
      schemas: {
        input: z.object({ question: z.string(), transcript: transcriptSchema }),
        output: z.string(),
      },
      model: "facilitator",
      system:
        "You are a neutral debate facilitator. Summarize the strongest points from " +
        "BOTH the affirmative and the negative side, then give a balanced verdict.",
      prompt: ({ input }) =>
        [`Question: ${input.question}`, `Transcript: ${JSON.stringify(input.transcript)}`].join(
          "\n",
        ),
    },
  },
});

/** Whose turn it is at transcript position `index`: A, B, A, B, … */
function turnAt(index: number) {
  const stance = index % 2 === 0 ? "affirmative" : "negative";
  return { stance, round: Math.floor(index / 2) + 1 } as const;
}

export const debateMachine = facilitatorAgentSetup.createMachine({
  id: "debate-facilitator",
  context: ({ input }) => ({
    question: input.question,
    rounds: input.rounds,
    transcript: [],
    conclusion: null,
  }),
  invoke: [
    {
      id: "affirmative",
      src: "affirmative",
      input: ({ context }) => ({ stance: "affirmative", question: context.question }),
    },
    {
      id: "negative",
      src: "negative",
      input: ({ context }) => ({ stance: "negative", question: context.question }),
    },
  ],
  initial: "requesting",
  states: {
    requesting: {
      always: ({ context, children }, enq) => {
        const turn = turnAt(context.transcript.length);
        enq.sendTo(children[turn.stance], {
          type: "DEBATE.ARGUMENT_REQUESTED",
          round: turn.round,
          transcript: context.transcript,
        });
        return { target: "awaiting" };
      },
    },
    awaiting: {
      on: {
        "DEBATE.ARGUMENT_SUBMITTED": ({ context, event }) => {
          const transcript = [
            ...context.transcript,
            { stance: event.stance, round: event.round, text: event.text },
          ];
          // Two turns (A + B) per round.
          return transcript.length >= context.rounds * 2
            ? { target: "concluding", context: { transcript } }
            : { target: "requesting", context: { transcript } };
        },
      },
    },
    concluding: {
      invoke: {
        id: "concludeDebate",
        src: "concludeDebate",
        input: ({ context }) => ({ question: context.question, transcript: context.transcript }),
        onDone: ({ output }) => ({ target: "done", context: { conclusion: output } }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        conclusion: context.conclusion,
        transcript: context.transcript,
      }),
    },
  },
});

export async function runDebateSubAgentsExample(options?: {
  input?: { question: string; rounds?: number };
  generateText?: AgentRequestExecutor;
  onTransition?: (value: unknown) => void;
}) {
  const generateText = options?.generateText ?? createAiSdkExecutors({ models }).generateText;

  // Each debater is a nested child machine. runAgent wraps only the parent's
  // own sources, so the child's `composeArgument` request is bound here with
  // the same injected `generateText` before the child is registered.
  const boundDebater = () =>
    debaterMachine.provide({
      actorSources: {
        composeArgument: bindRequestExecutor(
          debaterAgentSetup.requests.composeArgument,
          generateText,
        ),
      },
    });

  const result = await runAgent(debateMachine, {
    input: {
      question: options?.input?.question ?? "Should agents be modeled as actors?",
      rounds: options?.input?.rounds ?? DEFAULT_ROUNDS,
    },
    generateText,
    actorSources: { affirmative: boundDebater(), negative: boundDebater() },
    ...(options?.onTransition
      ? { onTransition: ({ value }: { value: unknown }) => options.onTransition!(value) }
      : {}),
  });

  if (result.status !== "done") {
    throw new Error(`Debate example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
  const output = await runDebateSubAgentsExample({
    onTransition: (value) => console.log(`[state] ${JSON.stringify(value)}`),
  });
  for (const turn of output.transcript) {
    console.log(`[R${turn.round} ${turn.stance}] ${turn.text}`);
  }
  console.log(`\n--- Facilitator verdict ---\n${output.conclusion}`);
});
