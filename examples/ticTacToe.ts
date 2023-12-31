import { assign, setup, assertEvent, createActor, raise } from 'xstate';
import { fromChatCompletionStream, fromEventChoice } from '../src/openai';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Player = 'x' | 'o';

const initialContext = {
  board: Array(9).fill(null) as Array<Player | null>,
  moves: 0,
  player: 'x' as Player,
  winner: undefined as Player | undefined,
  gameReport: '',
};

export const ticTacToeMachine = setup({
  types: {} as {
    context: typeof initialContext;
    events:
      | { type: 'x.play'; index: number }
      | {
          type: 'o.play';
          index: number;
        }
      | { type: 'RESET' };
  },
  actors: {
    bot: fromEventChoice(
      openai,
      ({ context }: { context: typeof initialContext }) => ({
        model: 'gpt-4-1106-preview',
        messages: [
          {
            role: 'system',
            content: `You are playing a game of tic tac toe. This is the current game state. The 3x3 board is represented by a 9-element array. The first element is the top-left cell, the second element is the top-middle cell, the third element is the top-right cell, the fourth element is the middle-left cell, and so on. The value of each cell is either null, x, or o. The value of null means that the cell is empty. The value of x means that the cell is occupied by an x. The value of o means that the cell is occupied by an o.

${JSON.stringify(context, null, 2)}`,
          },
          {
            role: 'user',
            content:
              'Execute the single best next move to try to win the game. Do not play on an existing cell.',
          },
        ],
      })
    ),
    gameReporter: fromChatCompletionStream(
      openai,
      ({ context }: { context: typeof initialContext }) => ({
        model: 'gpt-4-1106-preview',
        messages: [
          {
            role: 'user',
            content: `The tic-tac-toe game is over. The winner is ${
              context.winner ?? 'nobody'
            }. This was the ending board state:
          
${JSON.stringify(context.board, null, 2)}

Provide a game report analyzing the game.`,
          },
        ],
        stream: true,
      })
    ),
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
    }),
    resetGame: assign(initialContext),
    setWinner: assign({
      winner: ({ context }) => (context.player === 'x' ? 'o' : 'x'),
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
                meta: {
                  parameters: {
                    index: {
                      description: 'The index of the cell to play on',
                      type: 'number',
                      min: 0,
                      max: 8,
                    },
                  },
                },
              },
              { reenter: true },
            ],
          },
        },
        o: {
          invoke: {
            src: 'bot',
            input: ({ context }) => ({ context }),
            onDone: {
              // @ts-ignore
              actions: raise(({ event }) => {
                console.log('output', event.output);
                return event.output![0];
              }),
            },
          },
          on: {
            'o.play': [
              {
                target: 'x',
                guard: 'isValidMove',
                actions: 'updateBoard',
                meta: {
                  parameters: {
                    index: {
                      description: 'The index of the cell to play on',
                      type: 'number',
                      min: 0,
                      max: 8,
                    },
                  },
                },
              },
              { reenter: true },
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
        RESET: {
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
