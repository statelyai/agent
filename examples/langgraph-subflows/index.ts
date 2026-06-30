import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphSubflowsExample() {
  const childAgent = setupAgent({
    context: z.object({ topic: z.string(), research: z.string().nullable() }),
    input: z.object({ topic: z.string() }),
    output: z.object({ research: z.string() }),
    requests: {
      researchTopic: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'researcher',
        prompt: ({ input }) => input.topic,
      },
    },
  });
  const childMachine = childAgent.createMachine({
    id: 'raw-xstate-child-research',
    context: ({ input }) => ({ topic: input.topic, research: null }),
    initial: 'researching',
    states: {
      researching: {
        invoke: {
          src: 'researchTopic',
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { research: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ research: context.research ?? '' }),
      },
    },
  });

  const parentAgent = setupAgent({
    context: z.object({ topic: z.string(), research: z.string().nullable() }),
    input: z.object({ topic: z.string() }),
    output: z.object({ research: z.string() }),
    actors: { child: childMachine },
  });
  const parentMachine = parentAgent.createMachine({
    id: 'raw-xstate-parent-subflow',
    context: ({ input }) => ({ topic: input.topic, research: null }),
    initial: 'delegating',
    states: {
      delegating: {
        invoke: {
          src: 'child',
          input: ({ context }: { context: { topic: string } }) => ({
            topic: context.topic,
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { research: (output as { research: string }).research },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ research: context.research ?? '' }),
      },
    },
  });

  const actor = createActor(
    parentMachine.provide({
      actorSources: {
        child: childMachine.provide({
          actorSources: {
            researchTopic: childAgent.requests.researchTopic.withExecutor(
              async ({ input }) => `Research: ${input.topic}`,
            ),
          },
        }),
      },
    }),
    { input: { topic: 'agents' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    research: 'Research: agents',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphSubflowsExample();
}
