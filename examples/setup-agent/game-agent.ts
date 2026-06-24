import { z } from 'zod';
import { assign } from 'xstate';
import { createAgentSchemas, createTextLogic, setupAgent } from '../../src/index.js';

export const turnSummarySchema = z.object({
  summary: z.string(),
  enemyHp: z.number(),
  playerHp: z.number(),
});

const contextSchema = z.object({
  playerHp: z.number(),
  enemyHp: z.number(),
  defended: z.boolean(),
  lastSummary: z.string().nullable(),
});

const inputSchema = z.object({
  playerHp: z.number().default(20),
  enemyHp: z.number().default(15),
});

const outputSchema = z.object({
  outcome: z.enum(['continue', 'won', 'lost', 'fled']),
  summary: z.string(),
  playerHp: z.number(),
  enemyHp: z.number(),
});

const eventSchemas = {
  ATTACK: z.object({ target: z.string().default('goblin') }),
  DEFEND: z.object({}),
  HEAL: z.object({ amount: z.number().min(1).max(8).default(4) }),
  FLEE: z.object({}),
};

const schemas = createAgentSchemas({
  context: contextSchema,
  input: inputSchema,
  output: outputSchema,
  events: eventSchemas,
});

export const chooseMove = createTextLogic({
  schemas: {
    input: z.object({
      playerHp: z.number(),
      enemyHp: z.number(),
    }),
    output: z.string(),
  },
  model: 'openai/gpt-5.4-nano',
  system: 'You are playing a turn-based game. Choose exactly one legal event tool.',
  prompt: ({ input }) =>
    [
      `Player HP: ${input.playerHp}`,
      `Enemy HP: ${input.enemyHp}`,
      'Pick the best legal move.',
    ].join('\n'),
  events: ({ input }) =>
    input.playerHp <= 6
      ? ['ATTACK', 'DEFEND', 'HEAL', 'FLEE']
      : ['ATTACK', 'DEFEND', 'FLEE'],
});

export const summarizeTurn = createTextLogic({
  schemas: {
    input: z.object({
      playerHp: z.number(),
      enemyHp: z.number(),
      defended: z.boolean(),
    }),
    output: turnSummarySchema,
  },
  model: 'openai/gpt-5.4-nano',
  system: 'Narrate the turn and return updated HP totals.',
  prompt: ({ input }) =>
    [
      `Player HP: ${input.playerHp}`,
      `Enemy HP: ${input.enemyHp}`,
      `Defended: ${input.defended}`,
    ].join('\n'),
});

const gameAgent = setupAgent({
  schemas,
  actors: {
    chooseMove,
    summarizeTurn,
  },
});

export const gameSchemas = gameAgent.schemas;

export const gameMachine = gameAgent.createMachine({
  id: 'turn-based-game-agent',
  context: ({ input }) => ({
    playerHp: input.playerHp,
    enemyHp: input.enemyHp,
    defended: false,
    lastSummary: null,
  }),
  initial: 'choosingMove',
  states: {
    choosingMove: {
      invoke: {
        id: 'chooseMove',
        src: 'chooseMove',
        input: ({ context }) => ({
          playerHp: context.playerHp,
          enemyHp: context.enemyHp,
        }),
        onDone: { target: 'summarizing' },
      },
      on: {
        ATTACK: {
          target: 'summarizing',
          actions: assign({
            enemyHp: ({ context }) => Math.max(0, context.enemyHp - 6),
            defended: false,
          }),
        },
        DEFEND: {
          target: 'summarizing',
          actions: assign({ defended: true }),
        },
        HEAL: {
          target: 'summarizing',
          actions: assign({
            playerHp: ({ context, event }) =>
              Math.min(20, context.playerHp + event.amount),
            defended: false,
          }),
        },
        FLEE: { target: 'fled' },
      },
    },
    summarizing: {
      invoke: {
        id: 'summarizeTurn',
        src: 'summarizeTurn',
        input: ({ context }) => ({
          playerHp: context.playerHp,
          enemyHp: context.enemyHp,
          defended: context.defended,
        }),
        onDone: {
          target: 'checkingOutcome',
          actions: assign({
            playerHp: ({ event }) => event.output.playerHp,
            enemyHp: ({ event }) => event.output.enemyHp,
            lastSummary: ({ event }) => event.output.summary,
          }),
        },
      },
    },
    checkingOutcome: {
      always: [
        { guard: ({ context }) => context.enemyHp <= 0, target: 'won' },
        { guard: ({ context }) => context.playerHp <= 0, target: 'lost' },
        { target: 'done' },
      ],
    },
    done: {
      type: 'final',
      output: ({ context }) => ({
        outcome: 'continue',
        summary: context.lastSummary ?? '',
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    won: {
      type: 'final',
      output: ({ context }) => ({
        outcome: 'won',
        summary: context.lastSummary ?? 'You won.',
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    lost: {
      type: 'final',
      output: ({ context }) => ({
        outcome: 'lost',
        summary: context.lastSummary ?? 'You lost.',
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    fled: {
      type: 'final',
      output: ({ context }) => ({
        outcome: 'fled',
        summary: 'You fled the encounter.',
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
  },
});
