/**
 * Twenty Questions — decision loop + guard-enforced legality + idle-first
 * human-in-the-loop.
 *
 * The agent asks yes/no questions to narrow down a secret, then guesses.
 * Showcases:
 *   - `createDecisionLogic`/`sendDecision()`: the model picks exactly one
 *     currently-legal event (ASK or GUESS) each turn.
 *   - Guard-enforced legality: ASK is only legal while `questionsRemaining
 *     > 0` (a v6 function-transition returning `undefined` when illegal).
 *     If the model chooses ASK at 0 remaining, `resolveDecision`'s mode-3
 *     `canTake` check rejects it (`failure: 'rejected-by-guard'`) and
 *     retries — this is the guard showcase.
 *   - Idle-first HITL: `awaitingAnswer` has no invoke; under `runAgent` it
 *     settles `{ status: 'idle' }` and the host resumes with the human's
 *     ANSWER_YES/ANSWER_NO once they've answered.
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/twenty-questions/index.ts
 */
import { z } from 'zod';
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  createAgentSchemas,
  createDecisionLogic,
  getAcceptedEvents,
  runAgent,
  sendDecision,
  setupAgent,
  type AgentDecisionExecutor,
} from '../../src/index.js';

export const twentyQuestionsSchemas = createAgentSchemas({
  context: z.object({
    questionsRemaining: z.number(),
    transcript: z.array(
      z.object({ question: z.string(), answer: z.enum(['yes', 'no']) })
    ),
    guess: z.string().nullable(),
  }),
  input: z.object({
    questionsRemaining: z.number().default(20),
  }),
  output: z.object({
    guess: z.string(),
    questionsUsed: z.number(),
  }),
  events: {
    ASK: z.object({ question: z.string() }),
    GUESS: z.object({ answer: z.string() }),
    ANSWER_YES: z.object({}),
    ANSWER_NO: z.object({}),
  },
});

export const chooseAction = createDecisionLogic({
  schemas: {
    input: z.object({
      questionsRemaining: z.number(),
      transcript: z.array(
        z.object({ question: z.string(), answer: z.enum(['yes', 'no']) })
      ),
    }),
  },
  model: 'openai/gpt-4.1-mini',
  system:
    'You are playing twenty questions. Ask one yes/no question at a time to ' +
    'narrow down the secret, or guess once you are confident. You have a ' +
    'limited number of questions remaining.',
  prompt: ({ input }) =>
    [
      `Questions remaining: ${input.questionsRemaining}`,
      'Transcript so far:',
      input.transcript.length === 0
        ? '(none yet)'
        : input.transcript
            .map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`)
            .join('\n'),
      input.questionsRemaining > 0
        ? 'Ask a yes/no question (ASK) or make your guess (GUESS).'
        : 'You are out of questions — you must guess now (GUESS).',
    ].join('\n'),
  allowedEvents: ['ASK', 'GUESS'] as const,
});

export const twentyQuestionsActors = {
  chooseAction,
};

const agent = setupAgent({
  schemas: twentyQuestionsSchemas,
  actors: twentyQuestionsActors,
});

export const twentyQuestionsMachine = agent.createMachine({
  id: 'twenty-questions',
  context: ({ input }) => ({
    questionsRemaining: input.questionsRemaining,
    transcript: [],
    guess: null,
  }),
  output: ({ context }) => ({
    guess: context.guess ?? '',
    questionsUsed: context.transcript.length,
  }),
  initial: 'deciding',
  states: {
    deciding: {
      invoke: {
        id: 'chooseAction',
        src: 'chooseAction',
        input: ({ context }) => ({
          questionsRemaining: context.questionsRemaining,
          transcript: context.transcript,
        }),
        onDone: sendDecision(),
        onError: { target: 'stumped' },
      },
      on: {
        // Guard: ASK is only legal while questions remain. Returning
        // `undefined` makes the transition illegal — `snapshot.can(event)`
        // (resolveDecision's mode-3 check) will reject an ASK chosen at 0
        // remaining, recording `failure: 'rejected-by-guard'` and retrying.
        ASK: ({ context, event }) =>
          context.questionsRemaining > 0
            ? {
                target: 'awaitingAnswer',
                context: {
                  transcript: [
                    ...context.transcript,
                    { question: event.question, answer: 'yes' as const },
                  ],
                  questionsRemaining: context.questionsRemaining - 1,
                },
              }
            : undefined,
        GUESS: ({ context, event }) => ({
          target: 'revealing',
          context: { guess: event.answer },
        }),
      },
    },

    // No invoke — waits for the human's answer. Under runAgent this settles
    // { status: 'idle' }; the host asks the human, then resumes with
    // { snapshot, event: { type: 'ANSWER_YES' | 'ANSWER_NO' } }.
    awaitingAnswer: {
      on: {
        ANSWER_YES: ({ context }) => ({
          target: 'deciding',
          context: {
            transcript: [
              ...context.transcript.slice(0, -1),
              { ...context.transcript.at(-1)!, answer: 'yes' as const },
            ],
          },
        }),
        ANSWER_NO: ({ context }) => ({
          target: 'deciding',
          context: {
            transcript: [
              ...context.transcript.slice(0, -1),
              { ...context.transcript.at(-1)!, answer: 'no' as const },
            ],
          },
        }),
      },
    },

    revealing: {
      type: 'final',
      output: ({ context }) => ({
        guess: context.guess ?? '',
        questionsUsed: context.transcript.length,
      }),
    },

    // Reached when chooseAction exhausts its retries (DecisionExhaustedError).
    stumped: {
      type: 'final',
      output: ({ context }) => ({ guess: '', questionsUsed: context.transcript.length }),
    },
  },
});

// ─── AI SDK demo host ───

function resolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ''));
}

// decide executor: tool-per-event + toolChoice 'required', reads the chosen
// event off the tool call (docs/p0-design.md §2.6 recipe).
const decide: AgentDecisionExecutor = async (request) => {
  const model = resolveModel(request.model);
  const tools = Object.fromEntries(
    request.events.map((event) => [
      event.toolName,
      tool({
        description: `Choose the '${event.type}' action.`,
        inputSchema: (event.inputSchema as z.ZodType) ?? z.object({}),
      }),
    ])
  );

  const result = await generateText({
    model,
    system: request.system,
    prompt: request.prompt ?? '',
    tools,
    toolChoice: 'required',
    stopWhen: stepCountIs(1),
    temperature: request.temperature,
  });

  const toolCall = result.toolCalls[0];
  if (!toolCall) {
    throw new Error('Model did not call an event tool.');
  }
  const chosenEvent = request.events.find(
    (event) => event.toolName === toolCall.toolName
  );
  if (!chosenEvent) {
    throw new Error(`Model called unknown tool '${toolCall.toolName}'.`);
  }

  return {
    event: {
      ...(toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {}),
      type: chosenEvent.type,
    },
  };
};

async function promptYesNo(question: string): Promise<'yes' | 'no'> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (y/n) `);
    return /^y/i.test(answer.trim()) ? 'yes' : 'no';
  } finally {
    rl.close();
  }
}

export async function main() {
  let result = await runAgent(twentyQuestionsMachine, {
    input: { questionsRemaining: 20 },
    generateText: async () => ({}),
    decide,
  });

  while (result.status === 'idle') {
    const lastQuestion = result.snapshot.context.transcript.at(-1)?.question;
    const accepted = getAcceptedEvents(result.snapshot);
    if (!lastQuestion || !accepted.some((e) => e.type.startsWith('ANSWER_'))) {
      throw new Error('Unexpected idle state waiting for an answer.');
    }

    const answer = await promptYesNo(lastQuestion);
    result = await runAgent(twentyQuestionsMachine, {
      snapshot: result.snapshot,
      event: { type: answer === 'yes' ? 'ANSWER_YES' : 'ANSWER_NO' },
      generateText: async () => ({}),
      decide,
    });
  }

  if (result.status !== 'done') {
    throw new Error(`Twenty questions did not complete: ${result.status}`);
  }

  console.log(`Guess: ${result.output.guess} (used ${result.output.questionsUsed} questions)`);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  void main();
}
