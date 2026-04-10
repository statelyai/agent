import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const serviceReplySchema = z.object({
  response: z.string(),
});

const customerReplySchema = z.object({
  response: z.string(),
  done: z.boolean(),
  outcome: z.string().nullable(),
});

type TranscriptContext = {
  issue: string;
  transcript: string[];
  turnCount: number;
  maxTurns: number;
  outcome: string | null;
};

export function createCustomerServiceSimExample(
  options: {
    serviceReply?: (context: TranscriptContext) => Promise<z.infer<typeof serviceReplySchema>>;
    customerReply?: (context: TranscriptContext) => Promise<z.infer<typeof customerReplySchema>>;
    maxTurns?: number;
  } = {}
) {
  const serviceReply =
    options.serviceReply ??
    ((context: TranscriptContext) =>
      generateExampleObject({
        schema: serviceReplySchema,
        system: 'You are a customer support agent negotiating calmly and pragmatically.',
        prompt: [
          `Issue: ${context.issue}`,
          `Turn count: ${context.turnCount}`,
          `Current outcome: ${context.outcome ?? 'none'}`,
          '',
          'Transcript so far:',
          context.transcript.join('\n'),
          '',
          'Write the next support agent response in one short paragraph.',
        ].join('\n'),
      }));
  const customerReply =
    options.customerReply ??
    ((context: TranscriptContext) =>
      generateExampleObject({
        schema: customerReplySchema,
        system: 'You are the customer in the support exchange. Stay realistic and concise.',
        prompt: [
          `Original issue: ${context.issue}`,
          `Turn count: ${context.turnCount}`,
          '',
          'Transcript so far:',
          context.transcript.join('\n'),
          '',
          'Write the next customer reply. Set done=true only if the issue is resolved or the customer accepts the proposed outcome. Use outcome to summarize the result when done.',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'customer-service-sim-example',
    schemas: {
      input: z.object({ issue: z.string() }),
    },
    context: (input) => ({
      issue: input.issue,
      transcript: [`Customer: ${input.issue}`],
      turnCount: 0,
      maxTurns: options.maxTurns ?? 4,
      outcome: null as string | null,
    }),
    initial: 'service',
    states: {
      service: {
        resultSchema: serviceReplySchema,
        invoke: async ({ context }) => serviceReply(context),
        onDone: ({ result, context }) => ({
          target: context.turnCount + 1 >= context.maxTurns ? 'done' : 'customer',
          context: {
            transcript: [...context.transcript, `Agent: ${result.response}`],
            outcome:
              context.turnCount + 1 >= context.maxTurns
                ? 'max-turns-reached'
                : context.outcome,
          },
        }),
      },
      customer: {
        resultSchema: customerReplySchema,
        invoke: async ({ context }) => customerReply(context),
        onDone: ({ result, context }) => ({
          target: result.done ? 'done' : 'service',
          context: {
            transcript: [...context.transcript, `Customer: ${result.response}`],
            turnCount: context.turnCount + 1,
            outcome: result.outcome,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          transcript: context.transcript,
          turnCount: context.turnCount,
          outcome: context.outcome,
        }),
      },
    },
  });
}

async function main() {
  try {
    const issue = await prompt('Customer issue');
    const machine = createCustomerServiceSimExample();
    console.log(formatResult(await machine.execute(machine.getInitialState({ issue }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
