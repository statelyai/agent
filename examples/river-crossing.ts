import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import { formatResult, isMain } from './_run.js';

const bankItem = z.enum(['wolf', 'goat', 'cabbage']);

const crossingMoveSchema = z.object({
  move: z.enum(['takeGoat', 'takeWolf', 'takeCabbage', 'returnEmpty', 'done']),
  reasoning: z.string(),
});

const crossingStateSchema = z.object({
  leftBank: z.array(bankItem),
  rightBank: z.array(bankItem),
  farmerPosition: z.enum(['left', 'right']),
  step: z.string(),
});

function chooseCrossingMove(
  leftBank: string[],
  rightBank: string[],
  farmerPosition: 'left' | 'right'
): z.infer<typeof crossingMoveSchema> {
  const key = `${farmerPosition}|${leftBank.sort().join(',')}|${rightBank.sort().join(',')}`;
  const plan: Record<string, z.infer<typeof crossingMoveSchema>> = {
    'left|cabbage,goat,wolf|': {
      move: 'takeGoat',
      reasoning: 'Move the goat first so it is not left with the cabbage.',
    },
    'right|cabbage,wolf|goat': {
      move: 'returnEmpty',
      reasoning: 'Return alone to ferry another item.',
    },
    'left|cabbage,wolf|goat': {
      move: 'takeWolf',
      reasoning: 'Take the wolf across while the goat waits safely alone.',
    },
    'right|cabbage|goat,wolf': {
      move: 'takeGoat',
      reasoning: 'Bring the goat back so the wolf is not left with it.',
    },
    'left|cabbage,goat|wolf': {
      move: 'takeCabbage',
      reasoning: 'Take the cabbage across now that the goat is with you.',
    },
    'right|goat|cabbage,wolf': {
      move: 'returnEmpty',
      reasoning: 'Return alone to fetch the goat.',
    },
    'left|goat|cabbage,wolf': {
      move: 'takeGoat',
      reasoning: 'Bring the goat across to complete the crossing.',
    },
    'right||cabbage,goat,wolf': {
      move: 'done',
      reasoning: 'Everyone is safely across.',
    },
  };

  return plan[key] ?? { move: 'done', reasoning: 'No further move required.' };
}

function moveItem(
  leftBank: Array<'wolf' | 'goat' | 'cabbage'>,
  rightBank: Array<'wolf' | 'goat' | 'cabbage'>,
  farmerPosition: 'left' | 'right',
  move: z.infer<typeof crossingMoveSchema>['move']
): z.infer<typeof crossingStateSchema> {
  const fromLeft = farmerPosition === 'left';

  if (move === 'returnEmpty') {
    return {
      leftBank,
      rightBank,
      farmerPosition: fromLeft ? 'right' : 'left',
      step: 'The farmer crossed the river alone.',
    };
  }

  const item = move.replace(/^take/, '').toLowerCase() as 'wolf' | 'goat' | 'cabbage';
  return {
    leftBank: fromLeft
      ? leftBank.filter((value) => value !== item)
      : [...leftBank, item].sort() as Array<'wolf' | 'goat' | 'cabbage'>,
    rightBank: fromLeft
      ? [...rightBank, item].sort() as Array<'wolf' | 'goat' | 'cabbage'>
      : rightBank.filter((value) => value !== item),
    farmerPosition: fromLeft ? 'right' : 'left',
    step: `The farmer took the ${item} across the river.`,
  };
}

export function createRiverCrossingExample() {
  return createAgentMachine({
    id: 'river-crossing-example',
    context: () => ({
      leftBank: ['wolf', 'goat', 'cabbage'] as Array<'wolf' | 'goat' | 'cabbage'>,
      rightBank: [] as Array<'wolf' | 'goat' | 'cabbage'>,
      farmerPosition: 'left' as 'left' | 'right',
      steps: [] as string[],
      reasoning: [] as string[],
    }),
    initial: 'choosing',
    states: {
      choosing: {
        resultSchema: crossingMoveSchema,
        invoke: async ({ context }) =>
          chooseCrossingMove(
            [...context.leftBank],
            [...context.rightBank],
            context.farmerPosition
          ),
        onDone: ({ result, context }) => {
          const nextReasoning = [...context.reasoning, result.reasoning];

          if (result.move === 'done') {
            return {
              target: 'done' as const,
              context: { reasoning: nextReasoning },
            };
          }

          return {
            target: 'moving' as const,
            params: { move: result.move },
            context: { reasoning: nextReasoning },
          };
        },
      },
      moving: {
        paramsSchema: z.object({
          move: crossingMoveSchema.shape.move.exclude(['done']),
        }),
        resultSchema: crossingStateSchema,
        invoke: async ({ context, params }) =>
          moveItem(
            [...context.leftBank],
            [...context.rightBank],
            context.farmerPosition,
            params.move as 'takeGoat' | 'takeWolf' | 'takeCabbage' | 'returnEmpty'
          ),
        onDone: ({ result, context }) => ({
          target: 'choosing',
          context: {
            leftBank: result.leftBank,
            rightBank: result.rightBank,
            farmerPosition: result.farmerPosition,
            steps: [...context.steps, result.step],
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          leftBank: context.leftBank,
          rightBank: context.rightBank,
          steps: context.steps,
          reasoning: context.reasoning,
        }),
      },
    },
  });
}

async function main() {
  const machine = createRiverCrossingExample();
  console.log(formatResult(await machine.execute(machine.getInitialState())));
}

if (isMain(import.meta.url)) {
  void main();
}
