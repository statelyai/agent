import { openai } from '@ai-sdk/openai';
import { createAgent } from '../src';
import { z } from 'zod';
import { createActor, log, setup } from 'xstate';

const agent = createAgent({
  model: openai('gpt-4-1106-preview'),
  events: {
    'agent.respond': z.object({
      response: z.string().describe('The response from the agent'),
    }),
    'agent.frontline.classify': z.object({
      category: z
        .enum(['billing', 'technical', 'other'])
        .describe('The category of the customer issue'),
    }),
    'agent.refund': z
      .object({
        response: z.string().describe('The response from the agent'),
      })
      .describe('The agent wants to refund the user'),
    'agent.technical.solve': z.object({
      solution: z
        .string()
        .describe('The solution provided by the technical agent'),
    }),
    'agent.endConversation': z
      .object({
        response: z.string().describe('The response from the agent'),
      })
      .describe('The agent ends the conversation'),
  },
});

const machine = setup({
  types: {
    events: agent.eventTypes,
    input: {} as string,
    context: {} as {
      customerIssue: string;
    },
  },
  actors: { agent: agent.fromDecision() },
}).createMachine({
  initial: 'frontline',
  context: ({ input }) => ({
    customerIssue: input,
  }),
  states: {
    frontline: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context,
          system: `You are frontline support staff for LangCorp, a company that sells computers.
          Be concise in your responses.
          You can chat with customers and help them with basic questions, but if the customer is having a billing or technical problem,
          do not try to answer the question directly or gather information.
          Instead, immediately transfer them to the billing or technical team by asking the user to hold for a moment.
          Otherwise, just respond conversationally.`,
          goal: `The previous conversation is an interaction between a customer support representative and a user.
          Classify whether the representative is routing the user to a billing or technical team, or whether they are just responding conversationally.`,
        }),
      },
      on: {
        'agent.frontline.classify': [
          {
            actions: log(({ event }) => event),
            guard: ({ event }) => event.category === 'billing',
            target: 'billing',
          },
          {
            actions: log(({ event }) => event),
            guard: ({ event }) => event.category === 'technical',
            target: 'technical',
          },
          {
            actions: log(({ event }) => event),
            target: 'conversational',
          },
        ],
      },
    },
    billing: {
      invoke: {
        src: 'agent',
        input: {
          system:
            'Your job is to detect whether a billing support representative wants to refund the user.',
          goal: `The following text is a response from a customer support representative. Extract whether they want to refund the user or not.`,
        },
      },
      on: {
        'agent.refund': {
          actions: log(({ event }) => event),
          target: 'refund',
        },
      },
    },
    technical: {
      invoke: {
        src: 'agent',
        input: {
          context: true,
          system: `You are an expert at diagnosing technical computer issues. You work for a company called LangCorp that sells computers. Help the user to the best of your ability, but be concise in your responses.`,
          goal: 'Solve the customer issue.',
        },
      },
      on: {
        'agent.technical.solve': {
          actions: log(({ event }) => event),
          target: 'conversational',
        },
      },
    },
    conversational: {
      invoke: {
        src: 'agent',
        input: {
          goal: 'You are a customer support agent that is ending the conversation with the customer. Respond politely and thank them for their time.',
        },
      },
      on: {
        'agent.endConversation': {
          actions: log((x) => x.event),
          target: 'end',
        },
      },
    },
    refund: {
      entry: () => console.log('Refunding...'),
      after: {
        1000: { target: 'conversational' },
      },
    },
    end: {
      type: 'final',
    },
  },
});

const actor = createActor(machine, {
  input: `I've changed my mind and I want a refund for order #182818!`,
});

actor.start();
