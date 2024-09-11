import { assign, createActor, log, setup } from 'xstate';
import { fromTerminal } from './helpers/helpers';
import { createAgent, fromDecision } from '../src';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';

const agent = createAgent({
  name: 'tutor',
  model: openai('gpt-4-1106-preview'),
  events: {
    teach: z.object({
      instruction: z
        .string()
        .describe(
          'The feedback to give the human, correcting any grammatical errors, misspellings, etc.'
        ),
    }),
    respond: z.object({
      response: z.string().describe('The response to the human in Spanish'),
    }),
  },
  system:
    'You are an expert Spanish tutor. You will respond to the human in Spanish.',
});

const machine = setup({
  types: {
    context: {} as {
      conversation: string[];
    },
    events: agent.types.events,
  },
  actors: { agent: fromDecision(agent), getFromTerminal: fromTerminal },
}).createMachine({
  initial: 'human',
  context: {
    conversation: [],
  },
  states: {
    human: {
      invoke: {
        src: 'getFromTerminal',
        input: 'Say something in Spanish:',
        onDone: {
          actions: assign({
            conversation: (x) =>
              x.context.conversation.concat(`User: ` + x.event.output),
          }),
          target: 'ai',
        },
      },
    },
    ai: {
      initial: 'teaching',
      states: {
        teaching: {
          invoke: {
            src: 'agent',
            input: (x) => ({
              context: true,
              goal: 'Give brief feedback to the human based on the most recent response of the conversation',
              maxTokens: 100,
            }),
          },
          on: {
            teach: {
              actions: (x) => console.log(x.event.instruction),
              target: 'responding',
            },
          },
        },
        responding: {
          invoke: {
            src: 'agent',
            input: (x) => ({
              context: true,
              goal: 'Respond to the last message of the conversation in Spanish',
            }),
          },
          on: {
            respond: {
              actions: [
                assign({
                  conversation: (x) =>
                    x.context.conversation.concat(`Agent: ` + x.event.response),
                }),
                log((x) => x.event.response),
              ],
              target: 'done',
            },
          },
        },
        done: { type: 'final' },
      },
      onDone: { target: 'human' },
    },
  },
});

createActor(machine).start();
