import { z } from 'zod';
import { createAgent, fromDecision, fromText } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, setup } from 'xstate';

const agent = createAgent({
  name: 'example',
  model: openai('gpt-4o-mini'),
  events: {
    'agent.englishSummary': z.object({
      text: z.string().describe('The summary in English'),
    }),
    'agent.spanishSummary': z.object({
      text: z.string().describe('The summary in Spanish'),
    }),
  },
});

const machine = setup({
  types: {
    events: agent.types.events,
  },
  actors: { agent: fromDecision(agent), summarizer: fromText(agent) },
}).createMachine({
  initial: 'summarizing',
  context: {
    patientVisit:
      'During my visit, the doctor explained my condition clearly. She listened to my concerns and recommended a treatment plan. My condition was diagnosed as X after a series of tests. I feel relieved to have a clear path forward with managing my health. Also, the staff were very friendly and helpful at check-in and check-out. Furthermore, the facilities were clean and well-maintained.',
  },
  states: {
    summarizing: {
      invoke: [
        {
          src: 'summarizer',
          input: ({ context }) => ({
            context,
            prompt:
              'Summarize the patient visit in a single sentence. The summary should be in English.',
          }),
          onDone: {
            actions: assign({
              englishSummary: ({ event }) => event.output.text,
            }),
          },
        },
        {
          src: 'summarizer',
          input: ({ context }) => ({
            context,
            prompt:
              'Summarize the patient visit in a single sentence. The summary should be in Spanish.',
          }),
          onDone: {
            actions: assign({
              spanishSummary: ({ event }) => event.output.text,
            }),
          },
        },
      ],
      always: {
        guard: ({ context }) =>
          context.englishSummary && context.spanishSummary,
        target: 'summarized',
      },
    },
    summarized: {
      entry: ({ context }) => {
        console.log(context.englishSummary);
        console.log(context.spanishSummary);
      },
    },
  },
});

const actor = createActor(machine);

actor.subscribe((s) => {
  console.log(s.context);
});

actor.start();
