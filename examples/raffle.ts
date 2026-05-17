import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from '../src/index.js';
import {
  closePrompt,
  generateExampleObject,
  isMain,
  prompt,
  waitForRunSnapshot,
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
      output: z.object({
        entries: z.array(z.string()),
        winner: z.string().nullable(),
        firstRunnerUp: z.string().nullable(),
        secondRunnerUp: z.string().nullable(),
        explanation: z.string().nullable(),
      }),
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
        schemas: { output: winnerSchema },
        invoke: async ({ context }) => pickWinner(context.entries),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            winner: output.winningEntry,
            firstRunnerUp: output.firstRunnerUp,
            secondRunnerUp: output.secondRunnerUp,
            explanation: output.explanation,
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
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
    });

    while (true) {
      const snapshot = await waitForRunSnapshot(
        run,
        (nextSnapshot) => nextSnapshot.status !== 'active'
      );

      if (snapshot.status === 'done') {
        console.log({
          status: snapshot.status,
          value: snapshot.value,
          context: snapshot.context,
          output: snapshot.output,
        });
        break;
      }

      const entry = await prompt('Entry (blank to draw)');
      await run.send(
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
