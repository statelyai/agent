import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import { formatResult, isMain } from './_run.js';

const moveSchema = z.object({
  move: z
    .enum(['fill5', 'pour5to3', 'empty3', 'done'])
    .describe('The next move in the water jug puzzle'),
  reasoning: z.string(),
});

const applySchema = z.object({
  jug3: z.number().int(),
  jug5: z.number().int(),
  step: z.string(),
});

function chooseWaterJugMove(jug3: number, jug5: number): z.infer<typeof moveSchema> {
  const key = `${jug3},${jug5}`;
  const plan: Record<string, z.infer<typeof moveSchema>> = {
    '0,0': { move: 'fill5', reasoning: 'Start by filling the larger jug.' },
    '0,5': { move: 'pour5to3', reasoning: 'Transfer water into the 3-gallon jug.' },
    '3,2': { move: 'empty3', reasoning: 'Empty the smaller jug to make room.' },
    '0,2': { move: 'pour5to3', reasoning: 'Move the remaining water into the 3-gallon jug.' },
    '2,0': { move: 'fill5', reasoning: 'Refill the 5-gallon jug.' },
    '2,5': { move: 'pour5to3', reasoning: 'Top off the 3-gallon jug to leave 4 gallons.' },
    '3,4': { move: 'done', reasoning: 'The 5-gallon jug now holds exactly 4 gallons.' },
  };

  return plan[key] ?? { move: 'done', reasoning: 'No further move required.' };
}

function applyWaterJugMove(
  jug3: number,
  jug5: number,
  move: z.infer<typeof moveSchema>['move']
): z.infer<typeof applySchema> {
  switch (move) {
    case 'fill5':
      return { jug3, jug5: 5, step: 'Filled the 5-gallon jug.' };
    case 'pour5to3': {
      const transfer = Math.min(3 - jug3, jug5);
      return {
        jug3: jug3 + transfer,
        jug5: jug5 - transfer,
        step: 'Poured from the 5-gallon jug into the 3-gallon jug.',
      };
    }
    case 'empty3':
      return { jug3: 0, jug5, step: 'Emptied the 3-gallon jug.' };
    default:
      return { jug3, jug5, step: 'Solved the puzzle.' };
  }
}

export function createJugsExample() {
  return createAgentMachine({
    id: 'jugs-example',
    schemas: {
      output: z.object({
        jug3: z.number(),
        jug5: z.number(),
        steps: z.array(z.string()),
        reasoning: z.array(z.string()),
      }),
    },
    context: () => ({
      jug3: 0,
      jug5: 0,
      steps: [] as string[],
      reasoning: [] as string[],
    }),
    initial: 'choosing',
    states: {
      choosing: {
        schemas: { output: moveSchema },
        invoke: async ({ context }) => chooseWaterJugMove(context.jug3, context.jug5),
        onDone: ({ output, context }) => {
          const nextReasoning = [...context.reasoning, output.reasoning];

          if (output.move === 'done') {
            return {
              target: 'done' as const,
              context: { reasoning: nextReasoning },
            };
          }

          return {
            target: 'applying' as const,
            input: { move: output.move },
            context: { reasoning: nextReasoning },
          };
        },
      },
      applying: {
        schemas: { input: z.object({
          move: moveSchema.shape.move.exclude(['done']),
        }), output: applySchema },
        invoke: async ({ context, input }) =>
          applyWaterJugMove(
            context.jug3,
            context.jug5,
            input.move as 'fill5' | 'pour5to3' | 'empty3'
          ),
        onDone: ({ output, context }) => ({
          target: 'choosing',
          context: {
            jug3: output.jug3,
            jug5: output.jug5,
            steps: [...context.steps, output.step],
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          jug3: context.jug3,
          jug5: context.jug5,
          steps: context.steps,
          reasoning: context.reasoning,
        }),
      },
    },
  });
}

async function main() {
  const machine = createJugsExample();
  console.log(formatResult(await machine.execute(machine.getInitialState())));
}

if (isMain(import.meta.url)) {
  void main();
}
