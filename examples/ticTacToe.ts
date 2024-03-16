import { assign, setup, assertEvent } from 'xstate';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createOpenAIAdapter, defineEvents, createAgent } from '../src';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Player = 'x' | 'o';

const eventSchemas = defineEvents({
  'x.play': z.object({
    index: z
      .number()
      .min(0)
      .max(8)
      .describe('The index of the cell to play on'),
  }),
  'o.play': z.object({
    index: z
      .number()
      .min(0)
      .max(8)
      .describe('The index of the cell to play on'),
  }),
  reset: z.object({}).describe('Reset the game to the initial state'),
});

eventSchemas.types;

interface GameContext {
  board: (Player | null)[];
  moves: number;
  player: Player;
  gameReport: string;
  events: string[];
}

const adapter = createOpenAIAdapter(openai, {
  model: 'gpt-4-1106-preview',
});

const initialContext = {
  board: Array(9).fill(null) as Array<Player | null>,
  moves: 0,
  player: 'x' as Player,
  gameReport: '',
  events: [],
} satisfies GameContext;

const bot = adapter.fromEvent(
  ({ context }: { context: GameContext }) => `
You are playing a game of tic tac toe. This is the current game state. The 3x3 board is represented by a 9-element array. The first element is the top-left cell, the second element is the top-middle cell, the third element is the top-right cell, the fourth element is the middle-left cell, and so on. The value of each cell is either null, x, or o. The value of null means that the cell is empty. The value of x means that the cell is occupied by an x. The value of o means that the cell is occupied by an o.

${JSON.stringify(context, null, 2)}

Execute the single best next move to try to win the game. Do not play on an existing cell.`
);

const gameReporter = adapter.fromChatStream(
  ({ context }: { context: GameContext }) => `Here is the game board:

${JSON.stringify(context.board, null, 2)}

And here are the events that led to this game state:

${context.events.join('\n')}

The winner is ${getWinner(context.board)}.

Provide a very short game report analyzing the game.`
);

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
  schemas: eventSchemas,
  types: {
    context: {} as GameContext,
    events: eventSchemas.types,
  },
  actors: {
    bot,
    gameReporter,
  },
  actions: {
    updateBoard: assign({
      board: ({ context, event }) => {
        assertEvent(event, ['x.play', 'o.play']);
        const updatedBoard = [...context.board];
        updatedBoard[event.index] = context.player;
        return updatedBoard;
      },
      moves: ({ context }) => context.moves + 1,
      player: ({ context }) => (context.player === 'x' ? 'o' : 'x'),
      events: ({ context, event }) => {
        return [...context.events, JSON.stringify(event)];
      },
    }),
    resetGame: assign(initialContext),
    recordEvent: assign({
      events: ({ context, event }) => {
        return [...context.events, JSON.stringify(event)];
      },
    }),
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
        assertEvent(event, ['o.play', 'x.play']);
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
          invoke: {
            src: 'bot',
            input: ({ context }) => ({ context }),
          },
          on: {
            'x.play': [
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
          invoke: {
            src: 'bot',
            input: ({ context }) => ({ context }),
          },
          on: {
            'o.play': [
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
        input: ({ context }) => ({ context }),
        onSnapshot: {
          actions: assign({
            gameReport: ({ context, event }) => {
              return (
                context.gameReport +
                (event.snapshot.context?.choices[0]?.delta.content ?? '')
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

const agent = createAgent(ticTacToeMachine);
agent.subscribe((s) => {
  console.log(s.value, s.context);
});
agent.start();
