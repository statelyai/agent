import { assign, setup, assertEvent, createActor, raise } from 'xstate';
import OpenAI from 'openai';
import { createAgent } from '../src/openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Player = 'x' | 'o';

const agent = createAgent(openai, {
  model: 'gpt-4-1106-preview',
  context: {
    board: {
      type: 'array',
      items: {
        type: ['null', 'string'],
        enum: [null, 'x', 'o'],
      },
      minItems: 9,
      maxItems: 9,
      description: 'The board of the tic-tac-toe game',
    },
    moves: {
      type: 'number',
      description: 'The number of moves that have been played',
    },
    player: {
      type: 'string',
      enum: ['x', 'o'],
      description: 'The player whose turn it is',
    },
    winner: {
      type: ['null', 'string'],
      enum: [null, 'x', 'o'],
      description: 'The player who won the game',
    },
    gameReport: {
      type: 'string',
      description: 'The game report',
    },
    events: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
  } as const,
  events: {
    'x.play': {
      properties: {
        index: {
          description: 'The index of the cell to play on',
          type: 'number',

          minimum: 0,
          maximum: 8,
        },
      },
    },
    'o.play': {
      properties: {
        index: {
          description: 'The index of the cell to play on',
          type: 'number',
          minimum: 0,
          maximum: 8,
        },
      },
    },
    reset: {
      properties: {},
    },
  },
});

const initialContext = {
  board: Array(9).fill(null) as Array<Player | null>,
  moves: 0,
  player: 'x' as Player,
  winner: null as Player | null,
  gameReport: '',
  events: [],
} satisfies typeof agent.types.context;

const bot = agent.fromEventChoice(
  ({ context }: { context: typeof agent.types.context }) => `
You are playing a game of tic tac toe. This is the current game state. The 3x3 board is represented by a 9-element array. The first element is the top-left cell, the second element is the top-middle cell, the third element is the top-right cell, the fourth element is the middle-left cell, and so on. The value of each cell is either null, x, or o. The value of null means that the cell is empty. The value of x means that the cell is occupied by an x. The value of o means that the cell is occupied by an o.

${JSON.stringify(context, null, 2)}

Execute the single best next move to try to win the game. Do not play on an existing cell.`
);

const gameReporter = agent.fromChatCompletionStream(
  ({
    context,
  }: {
    context: typeof agent.types.context;
  }) => `The tic-tac-toe game is over. The winner is ${
    context.winner ?? 'nobody'
  }. This was the ending board state, represented as a 9-element array:

${JSON.stringify(context.board, null, 2)}

And here are the events that led to this game state:

${context.events.join('\n')}

Provide a very short game report analyzing the game.`
);

export const ticTacToeMachine = setup({
  types: agent.types,
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
    setWinner: assign({
      winner: ({ context }) => (context.player === 'x' ? 'o' : 'x'),
    }),
    recordEvent: assign({
      events: ({ context, event }) => {
        return [...context.events, JSON.stringify(event)];
      },
    }),
  },
  guards: {
    checkWin: ({ context }) => {
      const { board } = context;
      const winningLines = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],
        [0, 4, 8],
        [2, 4, 6],
      ];

      for (let line of winningLines) {
        const xWon = line.every((index) => {
          return board[index] === 'x';
        });

        if (xWon) {
          return true;
        }

        const oWon = line.every((index) => {
          return board[index] === 'o';
        });

        if (oWon) {
          return true;
        }
      }

      return false;
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
            onDone: {
              actions: raise(({ event }) => {
                return event.output![0] as any;
              }),
            },
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
            onDone: {
              actions: raise(({ event }) => {
                return event.output![0]!;
              }),
            },
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
          entry: 'setWinner',
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
actor.subscribe((s) => {
  console.log(s.value, s.context);
});
actor.start();
