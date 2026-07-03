import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent, setupAgent } from '../../src/index.js';

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

  // The child is a nested machine invoked by name, not a top-level agent
  // request — runAgent only wraps the parent's own text/decision sources, so
  // the child's request keeps its own `.withExecutor()` binding (same as
  // giving the child machine to any other actor system) before being
  // registered as the parent's `child` actor source.
  const result = await runAgent(parentMachine, {
    input: { topic: 'agents' },
    generateText: async () => ({}),
    actorSources: {
      child: childMachine.provide({
        actorSources: {
          researchTopic: childAgent.requests.researchTopic.withExecutor(
            async ({ input }) => `Research: ${input.topic}`,
          ),
        },
      }),
    },
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    research: 'Research: agents',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphSubflowsExample();
}
