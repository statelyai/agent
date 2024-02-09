import { test, expect } from 'vitest';
import { createOpenAIAdapter } from './adapters/openai';
import OpenAI from 'openai';
import { createActor, fromPromise, toPromise } from 'xstate';

test('fromToolChoice', async () => {
  const openAi = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const adapter = createOpenAIAdapter(openAi, {
    model: 'gpt-3.5-turbo',
  });

  const toolChoice = adapter.fromToolChoice(
    () => 'Create an image of a donut',
    {
      makeIllustration: {
        description: 'Make an illustration',
        src: fromPromise(async () => {
          return 'Illustration';
        }),
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The name of the illustration',
            },
          },
          required: ['name'],
        },
      },
      getWeather: {
        description: 'Get the weather for a location',
        src: fromPromise(async () => {
          return 'Weather';
        }),
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'object',
              properties: {
                city: {
                  type: 'string',
                  description: 'The name of the city',
                },
                state: {
                  type: 'string',
                  description: 'The name of the state',
                },
              },
              required: ['city', 'state'],
            },
          },
          required: ['location'],
        },
      },
    }
  );

  const actor = createActor(toolChoice);

  actor.start();

  const res = await toPromise(actor);

  expect(res?.actorRef).toBeDefined();

  const res2 = await toPromise(res!.actorRef);

  expect(res2).toBe('Illustration');
});
