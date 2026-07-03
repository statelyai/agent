import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  initialTransition,
  transition,
  waitFor,
  type EventObject,
} from 'xstate';
import {
  assistantMessage,
  createAgentSchemas,
  executeAgentRequest,
  getAgentRequests,
  transitionResult,
  type AgentTextRequest,
  type AgentTools,
} from '../../src/index.js';
import { setupAgent } from '../../src/index.js';

export async function runDinavinterParallelAgentExample() {
  const resultSchema = z.object({
    thought: z.string(),
    doodleQuery: z.string(),
  });
  const schemas = createAgentSchemas({
    context: z.object({
      topic: z.string(),
      thought: z.string().nullable(),
      doodleQuery: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: resultSchema,
  });
  const models = {
    thinker: 'openai/gpt-5.4-nano',
    doodleFinder: 'openai/gpt-5.4-nano',
  } as const;
  const agent = setupAgent({
    schemas,
    models,
    requests: {
      think: {
        mode: 'stream',
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'thinker',
        prompt: ({ input }) => `Think about ${input.topic}.`,
      },
      findDoodle: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.object({ query: z.string() }),
        },
        model: 'doodleFinder',
        prompt: ({ input }) => `Find a doodle for ${input.topic}.`,
      },
    },
  });
  const machine = agent.createMachine({
    context: ({ input }) => ({
      topic: input.topic,
      thought: null,
      doodleQuery: null,
    }),
    type: 'parallel',
    states: {
      thinking: {
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'think',
              src: 'think',
              input: ({ context }) => ({ topic: context.topic }),
              onDone: ({ output }) => ({
                target: 'done',
                context: { thought: output },
              }),
            },
          },
          done: { type: 'final' },
        },
      },
      doodling: {
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'findDoodle',
              src: 'findDoodle',
              input: ({ context }) => ({ topic: context.topic }),
              onDone: ({ output }) => ({
                target: 'done',
                context: { doodleQuery: output.query },
              }),
            },
          },
          done: { type: 'final' },
        },
      },
    },
    output: ({ context }) => ({
      thought: context.thought ?? '',
      doodleQuery: context.doodleQuery ?? '',
    }),
  });

  let [snapshot, actions] = initialTransition(machine, { topic: 'XState' });
  const requests = getAgentRequests(actions, {
    snapshot,
    schemas,
    actors: agent.requests,
  });

  assert.deepEqual(
    requests.map((request) => [request.id, request.kind === 'text' ? request.mode : undefined]),
    [
      ['think', 'stream'],
      ['findDoodle', 'generate'],
    ],
  );

  for (const request of requests) {
    if (request.kind !== 'text') {
      throw new Error('Decision requests are not supported in this demo.');
    }
    const output = await executeAgentRequest(request, {
      generateText: async () => ({ output: { query: 'statechart sketch' } }),
      streamText: async () => ({ text: 'State machines make flow visible.' }),
    });
    [snapshot, actions] = transitionResult(
      machine,
      snapshot,
      request,
      output,
    );
  }

  assert.equal(snapshot.status, 'done');
  assert.deepEqual(snapshot.output, {
    thought: 'State machines make flow visible.',
    doodleQuery: 'statechart sketch',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runDinavinterParallelAgentExample();
}
