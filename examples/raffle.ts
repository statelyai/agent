import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const winnerSchema = z.object({
  winningEntry: z.string(),
  firstRunnerUp: z.string(),
  secondRunnerUp: z.string(),
  explanation: z.string(),
});

export function createRaffleExample(
  pickWinner: (entries: string[]) => Promise<z.infer<typeof winnerSchema>> = async (
    entries
  ) =>
    generateExampleObject({
      schema: winnerSchema,
      system: 'You are conducting a transparent demo raffle draw.',
      prompt: [
        'Choose one winner and two runners-up from the entries below.',
        'Do not invent names. Explain your selection briefly.',
        ...entries.map((entry, index) => `${index + 1}. ${entry}`),
      ].join('\n'),
    })
) {
  return createAgentMachine({
    id: 'raffle-example',
    schemas: {
      events: {
        'user.entry': z.object({ entry: z.string() }),
        'user.draw': z.object({}),
      },
    },
    context: () => ({
      entries: [] as string[],
      winner: null as string | null,
      firstRunnerUp: null as string | null,
      secondRunnerUp: null as string | null,
      explanation: null as string | null,
    }),
    initial: 'collecting',
    states: {
      collecting: {
        on: {
          'user.entry': ({ event, context }) => ({
            context: { entries: [...context.entries, event.entry] },
          }),
          'user.draw': ({ context }) => ({
            target: context.entries.length >= 3 ? 'drawing' : 'collecting',
          }),
        },
      },
      drawing: {
        resultSchema: winnerSchema,
        invoke: async ({ context }) => pickWinner(context.entries),
        onDone: ({ result }) => ({
          target: 'done',
          context: {
            winner: result.winningEntry,
            firstRunnerUp: result.firstRunnerUp,
            secondRunnerUp: result.secondRunnerUp,
            explanation: result.explanation,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          entries: context.entries,
          winner: context.winner,
          firstRunnerUp: context.firstRunnerUp,
          secondRunnerUp: context.secondRunnerUp,
          explanation: context.explanation,
        }),
      },
    },
  });
}

async function main() {
  try {
    const machine = createRaffleExample();
    let state = machine.getInitialState();

    while (true) {
      const result = await machine.execute(state);

      if (result.status === 'done') {
        console.log(formatResult(result));
        break;
      }

      if (result.status !== 'pending') {
        throw new Error('Raffle example entered an unexpected error state.');
      }

      const entry = await prompt('Entry (blank to draw)');
      state = machine.transition(
        result.state,
        entry ? { type: 'user.entry', entry } : { type: 'user.draw' }
      );
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
