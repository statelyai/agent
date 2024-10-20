import { assign, setup, assertEvent, createActor } from 'xstate';
import { z } from 'zod';
import { createAgent, fromDecision, fromTextStream } from '../src';
import { openai } from '@ai-sdk/openai';

const events = {
  'agent.x.play': z.object({
    index: z
      .number()
      .min(0)
      .max(8)
      .describe('The index of the cell to play on'),
  }),
  'agent.o.play': z.object({
    index: z
      .number()
      .min(0)
      .max(8)
      .describe('The index of the cell to play on'),
  }),
  reset: z.object({}).describe('Reset the game to the initial state'),
};

const context = {
  board: z
    .array(z.union([z.literal(null), z.literal('x'), z.literal('o')]))
    .describe('The 3x3 board represented as a 9-element array.'),
  moves: z
    .number()
    .min(0)
    .max(9)
    .describe('The number of moves made in the game.'),
  player: z
    .union([z.literal('x'), z.literal('o')])
    .describe('The current player (x or o)'),
  gameReport: z.string(),
};

const xAgent = createAgent({
  name: 'tic-tac-toe-learner',
  model: openai('gpt-4o-mini'),
  events,
  context,
});

const oAgent = createAgent({
  name: 'tic-tac-toe-noob',
  model: openai('gpt-4o-mini'),
  events,
  context,
});

type Player = 'x' | 'o';

const initialContext = {
  board: Array(9).fill(null) as Array<Player | null>,
  moves: 0,
  player: 'x' as Player,
  gameReport: '',
} satisfies typeof xAgent.types.context;

function getWinner(board: typeof initialContext.board): Player | null {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ] as const;
  for (const [a, b, c] of lines) {
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) {
      return board[a]!;
    }
  }
  return null;
}

export const ticTacToeMachine = setup({
  types: {
    context: xAgent.types.context,
    events: xAgent.types.events,
  },
  actors: {
    agent: fromDecision(xAgent),
    gameReporter: fromTextStream(xAgent),
  },
  actions: {
    updateBoard: assign({
      board: ({ context, event }) => {
        assertEvent(event, ['agent.x.play', 'agent.o.play']);
        const updatedBoard = [...context.board];
        updatedBoard[event.index] = context.player;
        return updatedBoard;
      },
      moves: ({ context }) => context.moves + 1,
      player: ({ context }) => (context.player === 'x' ? 'o' : 'x'),
    }),
    resetGame: assign(initialContext),
    printBoard: ({ context }) => {
      // Print the context.board in a 3 x 3 grid format
      let boardString = '';
      for (let i = 0; i < context.board.length; i++) {
        if ([0, 3, 6].includes(i)) {
          boardString += context.board[i] ?? ' ';
        } else {
          boardString += ' | ' + (context.board[i] ?? ' ');
          if ([2, 5].includes(i)) {
            boardString += '\n--+---+--\n';
          }
        }
      }

      console.log(boardString);
    },
  },
  guards: {
    checkWin: ({ context }) => {
      const winner = getWinner(context.board);

      return !!winner;
    },
    checkDraw: ({ context }) => {
      return context.moves === 9;
    },
    isValidMove: ({ context, event }) => {
      try {
        assertEvent(event, ['agent.o.play', 'agent.x.play']);
      } catch {
        return false;
      }

      return context.board[event.index] === null;
    },
  },
}).createMachine({
  initial: 'playing',
  context: initialContext,
  states: {
    playing: {
      always: [
        { target: 'gameOver.winner', guard: 'checkWin' },
        { target: 'gameOver.draw', guard: 'checkDraw' },
      ],
      initial: 'x',
      states: {
        x: {
          entry: 'printBoard',
          on: {
            'agent.x.play': [
              {
                target: 'o',
                guard: 'isValidMove',
                actions: 'updateBoard',
              },
              { target: 'x', reenter: true },
            ],
          },
        },
        o: {
          entry: 'printBoard',
          on: {
            'agent.o.play': [
              {
                target: 'x',
                guard: 'isValidMove',
                actions: 'updateBoard',
              },
              { target: 'o', reenter: true },
            ],
          },
        },
      },
    },
    gameOver: {
      initial: 'winner',
      invoke: {
        src: 'gameReporter',
        input: ({ context }) => ({
          context: {
            events: xAgent.getObservations().map((o) => o.event),
            board: context.board,
          },
          prompt: 'Provide a short game report analyzing the game.',
        }),
        onSnapshot: {
          actions: assign({
            gameReport: ({ context, event }) => {
              console.log(
                context.gameReport + (event.snapshot.context?.textDelta ?? '')
              );
              return (
                context.gameReport + (event.snapshot.context?.textDelta ?? '')
              );
            },
          }),
        },
      },
      states: {
        winner: {
          tags: 'winner',
        },
        draw: {
          tags: 'draw',
        },
      },
      on: {
        reset: {
          target: 'playing',
          actions: 'resetGame',
        },
      },
    },
  },
});

const actor = createActor(ticTacToeMachine);

xAgent.interact(actor, (observed) => {
  if (observed.state.matches({ playing: 'x' })) {
    return {
      goal: `You are playing a game of tic tac toe. This is the current game state. The 3x3 board is represented by a 9-element array. The first element is the top-left cell, the second element is the top-middle cell, the third element is the top-right cell, the fourth element is the middle-left cell, and so on. The value of each cell is either null, x, or o. The value of null means that the cell is empty. The value of x means that the cell is occupied by an x. The value of o means that the cell is occupied by an o.

${JSON.stringify(observed.state.context, null, 2)}

Execute the single best next move to try to win the game. Do not play on an existing cell.`,
    };
  }

  return;
});

oAgent.interact(actor, (observed) => {
  if (observed.state.matches({ playing: 'o' })) {
    return {
      goal: `You are playing a game of tic tac toe. This is the current game state. The 3x3 board is represented by a 9-element array. The first element is the top-left cell, the second element is the top-middle cell, the third element is the top-right cell, the fourth element is the middle-left cell, and so on. The value of each cell is either null, x, or o. The value of null means that the cell is empty. The value of x means that the cell is occupied by an x. The value of o means that the cell is occupied by an o.

${JSON.stringify(observed.state.context, null, 2)}

Execute the single best next move to try to win the game. Do not play on an existing cell.`,
    };
  }

  return;
});

actor.start();
