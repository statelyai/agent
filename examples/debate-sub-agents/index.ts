import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, toPromise, type AnyStateMachine } from 'xstate';
import { setupAgent } from '../../src/index.js';

const stanceSchema = z.enum(['affirmative', 'negative']);
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

type DebateSubAgentsWorkflow = {
  agent: { requests: Record<string, any> };
  machine: AnyStateMachine;
};

function nextTurn(index: number) {
  const stance = index % 2 === 0 ? 'affirmative' : 'negative';
  return {
    stance,
    actorId: `${stance}Debater`,
    round: Math.floor(index / 2) + 1,
  } as const;
}

function createDebaterAgent() {
  const agent = setupAgent({
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
      'DEBATE.ARGUMENT_REQUESTED': z.object({
        round: z.number(),
        question: z.string(),
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
        model: 'debater',
        system: ({ input }) =>
          `You argue the ${input.stance} side. Be concise and respond to the debate so far.`,
        prompt: ({ input }) =>
          [
            `Question: ${input.question}`,
            `Round: ${input.round}`,
            `Transcript: ${JSON.stringify(input.transcript)}`,
          ].join('\n'),
      },
    },
  });

  const machine = agent.createMachine({
    id: 'debater-agent',
    context: ({ input }) => ({
      stance: input.stance,
      question: input.question,
      round: null,
      transcript: [],
    }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          'DEBATE.ARGUMENT_REQUESTED': ({ event }) => {
            const request = event as unknown as {
              question: string;
              round: number;
              transcript: z.infer<typeof transcriptSchema>;
            };
            return {
              target: 'composing',
              context: {
                question: request.question,
                round: request.round,
                transcript: request.transcript,
              },
            };
          },
        },
      },
      composing: {
        invoke: {
          src: 'composeArgument',
          input: ({ context }) => ({
            stance: context.stance,
            question: context.question,
            round: context.round ?? 0,
            transcript: context.transcript,
          }),
          onDone: ({ context, output, parent }, enq) => {
            if (parent) {
              enq.sendTo(parent, {
                type: 'DEBATE.ARGUMENT_SUBMITTED',
                stance: context.stance,
                round: context.round ?? 0,
                text: output,
              } as never);
            }
            return { target: 'idle' };
          },
        },
      },
    },
  });

  return { agent, machine };
}

export function createDebateSubAgentsWorkflow(): DebateSubAgentsWorkflow {
  const debater = createDebaterAgent();
  const agent = setupAgent({
    context: z.object({
      question: z.string(),
      transcript: transcriptSchema,
      conclusion: z.string().nullable(),
    }),
    input: z.object({ question: z.string() }),
    output: conclusionSchema.extend({ transcript: transcriptSchema }),
    events: {
      'DEBATE.ARGUMENT_SUBMITTED': transcriptEntrySchema,
    },
    actors: {
      debater: debater.machine.provide({
        actorSources: {
          composeArgument: debater.agent.requests.composeArgument.withExecutor(
            async ({ input }) =>
              `${input.stance}:round-${input.round}:after-${input.transcript.length}`,
          ),
        },
      }),
    },
    requests: {
      concludeDebate: {
        schemas: {
          input: z.object({
            question: z.string(),
            transcript: transcriptSchema,
          }),
          output: conclusionSchema,
        },
        model: 'facilitator',
        system:
          'You are a neutral facilitator. Summarize the strongest arguments and give a conclusion.',
        prompt: ({ input }) =>
          [
            `Question: ${input.question}`,
            `Transcript: ${JSON.stringify(input.transcript)}`,
          ].join('\n'),
      },
    },
  });

  const machine = agent.createMachine({
    id: 'debate-sub-agents',
    context: ({ input }) => ({
      question: input.question,
      transcript: [],
      conclusion: null,
    }),
    invoke: [
      {
        id: 'affirmativeDebater',
        src: 'debater',
        input: ({ context }) => ({
          stance: 'affirmative',
          question: context.question,
        }),
      },
      {
        id: 'negativeDebater',
        src: 'debater',
        input: ({ context }) => ({
          stance: 'negative',
          question: context.question,
        }),
      },
    ],
    initial: 'requestingArgument',
    states: {
      requestingArgument: {
        always: ({ context, children }, enq) => {
          const turn = nextTurn(context.transcript.length);
          enq.sendTo(children[turn.actorId] as never, {
            type: 'DEBATE.ARGUMENT_REQUESTED',
            round: turn.round,
            question: context.question,
            transcript: context.transcript,
          } as never);
          return { target: 'waitingForArgument' };
        },
      },
      waitingForArgument: {
        on: {
          'DEBATE.ARGUMENT_SUBMITTED': ({ context, event }) => {
            const argument = event as unknown as z.infer<typeof transcriptEntrySchema>;
            const transcript = [...context.transcript, {
              stance: argument.stance,
              round: argument.round,
              text: argument.text,
            }];

            return transcript.length >= totalTurns
              ? { target: 'concluding', context: { transcript } }
              : { target: 'requestingArgument', context: { transcript } };
          },
        },
      },
      concluding: {
        invoke: {
          src: 'concludeDebate',
          input: ({ context }) => ({
            question: context.question,
            transcript: context.transcript,
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { conclusion: output.conclusion },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          conclusion: context.conclusion ?? '',
          transcript: context.transcript,
        }),
      },
    },
  });

  return { agent, machine };
}

export async function runDebateSubAgentsExample() {
  const { agent, machine } = createDebateSubAgentsWorkflow();
  const actor = createActor(
    machine.provide({
      actorSources: {
        concludeDebate: agent.requests.concludeDebate.withExecutor(
          async ({
            input,
          }: {
            input: { transcript: string[]; question: string };
          }) => ({
            conclusion: `conclusion:${input.transcript.length}:${input.question}`,
          }),
        ),
      },
    }),
    { input: { question: 'Should agents be modeled as actors?' } },
  );

  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    conclusion: 'conclusion:10:Should agents be modeled as actors?',
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

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runDebateSubAgentsExample();
}
