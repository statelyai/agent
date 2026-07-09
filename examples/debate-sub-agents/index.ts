/**
 * Two debater sub-agents (affirmative + negative) plus a neutral facilitator,
 * modeled as actors. The parent machine invokes both debaters as child
 * actors, requests one argument per turn via events, and collects the
 * transcript; after `totalTurns` the facilitator concludes.
 *
 * `runDebateSubAgentsExample` runs deterministically (mock executors) for the
 * test. `main` (direct run) wires real models: each debater's
 * `composeArgument` and the facilitator's `concludeDebate` are bound to the
 * AI SDK adapter — the request already carries its own model ref.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/debate-sub-agents/index.ts
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createActor, toPromise, type AnyStateMachine } from "xstate";
import { setupAgent, type TextLogic, type TextLogicExecutor } from "../../src/index.js";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";

const stanceSchema = z.enum(["affirmative", "negative"]);
const transcriptEntrySchema = z.object({
  stance: stanceSchema,
  round: z.number(),
  text: z.string(),
});
const transcriptSchema = z.array(transcriptEntrySchema);
const conclusionSchema = z.object({
  conclusion: z.string(),
});

const totalTurns = 10;

const concludeInputSchema = z.object({
  question: z.string(),
  transcript: transcriptSchema,
});

const composeInputSchema = z.object({
  stance: stanceSchema,
  question: z.string(),
  round: z.number(),
  transcript: transcriptSchema,
});

// A debater's `composeArgument` executor, typed straight from the request
// schemas (not `ReturnType<typeof createDebaterAgent>`, whose full inferred
// agent type is not serializable — TS7056).
type ComposeExecutor = TextLogicExecutor<typeof composeInputSchema, z.ZodString>;

// Precisely-typed workflow shape: `requests.concludeDebate` carries its real
// input/output schemas (no `Record<string, any>` leak), so a host's
// `.withExecutor(({ input }) => ...)` gets a typed `input` — which is why the
// executor no longer needs a hand-written input annotation. The full inferred
// agent type is too large to serialize (TS7056), so it is narrowed to just the
// members this workflow's consumers touch.
type DebateSubAgentsWorkflow = {
  agentSetup: {
    requests: {
      concludeDebate: TextLogic<typeof concludeInputSchema, typeof conclusionSchema>;
    };
  };
  machine: AnyStateMachine;
};

function nextTurn(index: number) {
  const stance = index % 2 === 0 ? "affirmative" : "negative";
  return {
    stance,
    actorId: `${stance}Debater`,
    round: Math.floor(index / 2) + 1,
  } as const;
}

function createDebaterAgent() {
  const agentSetup = setupAgent({
    context: z.object({
      stance: stanceSchema,
      question: z.string(),
      round: z.number().nullable(),
      transcript: transcriptSchema,
    }),
    input: z.object({
      stance: stanceSchema,
      question: z.string(),
    }),
    events: {
      "DEBATE.ARGUMENT_REQUESTED": z.object({
        round: z.number(),
        question: z.string(),
        transcript: transcriptSchema,
      }),
    },
    requests: {
      composeArgument: {
        schemas: {
          input: composeInputSchema,
          output: z.string(),
        },
        model: "debater",
        system: ({ input }) =>
          `You argue the ${input.stance} side. Be concise and respond to the debate so far.`,
        prompt: ({ input }) =>
          [
            `Question: ${input.question}`,
            `Round: ${input.round}`,
            `Transcript: ${JSON.stringify(input.transcript)}`,
          ].join("\n"),
      },
    },
  });

  const machine = agentSetup.createMachine({
    id: "debater-agent",
    context: ({ input }) => ({
      stance: input.stance,
      question: input.question,
      round: null,
      transcript: [],
    }),
    initial: "idle",
    states: {
      idle: {
        on: {
          "DEBATE.ARGUMENT_REQUESTED": ({ event }) => ({
            target: "composing",
            context: {
              question: event.question,
              round: event.round,
              transcript: event.transcript,
            },
          }),
        },
      },
      composing: {
        invoke: {
          src: "composeArgument",
          input: ({ context }) => ({
            stance: context.stance,
            question: context.question,
            round: context.round ?? 0,
            transcript: context.transcript,
          }),
          onDone: ({ context, output, parent }, enq) => {
            if (parent) {
              enq.sendTo(parent, {
                type: "DEBATE.ARGUMENT_SUBMITTED",
                stance: context.stance,
                round: context.round ?? 0,
                text: output,
              });
            }
            return { target: "idle" };
          },
        },
      },
    },
  });

  return { agentSetup, machine };
}

// The deterministic default keeps the example/test reproducible; the direct
// run swaps in a real model.
const deterministicCompose: ComposeExecutor = async ({ input }) => ({
  output: `${input.stance}:round-${input.round}:after-${input.transcript.length}`,
});

export function createDebateSubAgentsWorkflow(
  composeExecutor: ComposeExecutor = deterministicCompose,
): DebateSubAgentsWorkflow {
  const debater = createDebaterAgent();
  const agentSetup = setupAgent({
    context: z.object({
      question: z.string(),
      transcript: transcriptSchema,
      conclusion: z.string().nullable(),
    }),
    input: z.object({ question: z.string() }),
    output: conclusionSchema.extend({ transcript: transcriptSchema }),
    events: {
      "DEBATE.ARGUMENT_SUBMITTED": transcriptEntrySchema,
    },
    actorSources: {
      debater: debater.machine.provide({
        actorSources: {
          composeArgument:
            debater.agentSetup.requests.composeArgument.withExecutor(composeExecutor),
        },
      }),
    },
    requests: {
      concludeDebate: {
        schemas: {
          input: concludeInputSchema,
          output: conclusionSchema,
        },
        model: "facilitator",
        system:
          "You are a neutral facilitator. Summarize the strongest arguments and give a conclusion.",
        prompt: ({ input }) =>
          [`Question: ${input.question}`, `Transcript: ${JSON.stringify(input.transcript)}`].join(
            "\n",
          ),
      },
    },
  });

  const machine = agentSetup.createMachine({
    id: "debate-sub-agents",
    context: ({ input }) => ({
      question: input.question,
      transcript: [],
      conclusion: null,
    }),
    invoke: [
      {
        id: "affirmativeDebater",
        src: "debater",
        input: ({ context }) => ({
          stance: "affirmative",
          question: context.question,
        }),
      },
      {
        id: "negativeDebater",
        src: "debater",
        input: ({ context }) => ({
          stance: "negative",
          question: context.question,
        }),
      },
    ],
    initial: "requestingArgument",
    states: {
      requestingArgument: {
        always: ({ context, children }, enq) => {
          const turn = nextTurn(context.transcript.length);
          enq.sendTo(children[turn.actorId], {
            type: "DEBATE.ARGUMENT_REQUESTED",
            round: turn.round,
            question: context.question,
            transcript: context.transcript,
          });
          return { target: "waitingForArgument" };
        },
      },
      waitingForArgument: {
        on: {
          "DEBATE.ARGUMENT_SUBMITTED": ({ context, event }) => {
            const transcript = [
              ...context.transcript,
              {
                stance: event.stance,
                round: event.round,
                text: event.text,
              },
            ];

            return transcript.length >= totalTurns
              ? { target: "concluding", context: { transcript } }
              : { target: "requestingArgument", context: { transcript } };
          },
        },
      },
      concluding: {
        invoke: {
          src: "concludeDebate",
          input: ({ context }) => ({
            question: context.question,
            transcript: context.transcript,
          }),
          onDone: ({ output }) => ({
            target: "done",
            context: { conclusion: output.conclusion },
          }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({
          conclusion: context.conclusion ?? "",
          transcript: context.transcript,
        }),
      },
    },
  });

  return { agentSetup, machine };
}

export async function runDebateSubAgentsExample() {
  const { agentSetup, machine } = createDebateSubAgentsWorkflow();
  const actor = createActor(
    machine.provide({
      actorSources: {
        concludeDebate: agentSetup.requests.concludeDebate.withExecutor(async ({ input }) => ({
          output: {
            conclusion: `conclusion:${input.transcript.length}:${input.question}`,
          },
        })),
      },
    }),
    { input: { question: "Should agents be modeled as actors?" } },
  );

  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    conclusion: "conclusion:10:Should agents be modeled as actors?",
    transcript: Array.from({ length: totalTurns }, (_, index) => {
      const turn = nextTurn(index);
      return {
        stance: turn.stance,
        round: turn.round,
        text: `${turn.stance}:round-${turn.round}:after-${index}`,
      };
    }),
  });
}

// Direct run: real models for both debaters and the facilitator. Each request
// already carries its model ref ('debater' / 'facilitator'), so binding
// `generateText` from the AI SDK adapter is all the wiring needed.
export async function main() {
  const { generateText } = createAiSdkExecutors({
    models: {
      debater: openai("gpt-5.4-mini"),
      facilitator: openai("gpt-5.4-mini"),
    },
  });

  // Bridge a bound-logic executor (`{ request }`) to the AI SDK adapter. The
  // adapter reads `request.outputSchema` for structured requests, so the typed
  // `{ output }` envelope each logic expects is produced at runtime; the cast
  // narrows the adapter's `unknown` output back to that logic's output type.
  type AiSdkRequest = Parameters<typeof generateText>[0];
  const run = async <T>(request: { model: string }) => {
    const result = await generateText({ tools: {}, ...request } as AiSdkRequest);
    return { output: result.output as T };
  };

  const { agentSetup, machine } = createDebateSubAgentsWorkflow(({ request }) =>
    run<string>(request),
  );

  const actor = createActor(
    machine.provide({
      actorSources: {
        concludeDebate: agentSetup.requests.concludeDebate.withExecutor(({ request }) =>
          run<{ conclusion: string }>(request),
        ),
      },
    }),
    { input: { question: "Should agents be modeled as actors?" } },
  );

  actor.subscribe((snapshot) => console.log("[state]", JSON.stringify(snapshot.value)));
  actor.start();
  await toPromise(actor);

  const output = actor.getSnapshot().output as {
    conclusion: string;
    transcript: { stance: string; round: number; text: string }[];
  };
  for (const turn of output.transcript) {
    console.log(`[R${turn.round} ${turn.stance}] ${turn.text}`);
  }
  console.log(`\n--- Facilitator ---\n${output.conclusion}`);
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void main();
}
