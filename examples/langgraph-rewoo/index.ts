import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphReWOOExample() {
  const planSchema = z.object({
    steps: z.array(
      z.object({
        id: z.string(),
        request: z.string(),
      }),
    ),
  });
  const agent = setupAgent({
    context: z.object({
      goal: z.string(),
      steps: z.array(z.object({ id: z.string(), request: z.string() })),
      evidence: z.record(z.string(), z.string()),
      answer: z.string().nullable(),
    }),
    input: z.object({ goal: z.string() }),
    output: z.object({
      answer: z.string(),
      evidence: z.record(z.string(), z.string()),
    }),
    actors: {
      executePlan: createAsyncLogic<
        Record<string, string>,
        { steps: Array<{ id: string; request: string }> }
      >({
        run: async ({ input }) =>
          Object.fromEntries(
            input.steps.map((step: { id: string; request: string }) => [
              step.id,
              `result:${step.request}`,
            ]),
          ),
      }),
    },
    requests: {
      planWork: {
        schemas: {
          input: z.object({ goal: z.string() }),
          output: planSchema,
        },
        model: 'planner',
        prompt: ({ input }) => input.goal,
      },
      solveWork: {
        schemas: {
          input: z.object({ evidence: z.record(z.string(), z.string()) }),
          output: z.string(),
        },
        model: 'solver',
        prompt: ({ input }) => JSON.stringify(input.evidence),
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-rewoo',
    context: ({ input }) => ({
      goal: input.goal,
      steps: [],
      evidence: {},
      answer: null,
    }),
    initial: 'planning',
    states: {
      planning: {
        invoke: {
          src: 'planWork',
          input: ({ context }) => ({ goal: context.goal }),
          onDone: ({ output }) => ({
            target: 'working',
            context: { steps: output.steps },
          }),
        },
      },
      working: {
        invoke: {
          src: 'executePlan',
          input: ({ context }) => ({ steps: context.steps }),
          onDone: ({ output }) => ({
            target: 'solving',
            context: { evidence: output },
          }),
        },
      },
      solving: {
        invoke: {
          src: 'solveWork',
          input: ({ context }) => ({ evidence: context.evidence }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { answer: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          answer: context.answer ?? '',
          evidence: context.evidence,
        }),
      },
    },
  });

  const actor = createActor(
    machine.provide({
      actorSources: {
        planWork: agent.requests.planWork.withExecutor(async ({ input }) => ({
          steps: [{ id: 'E1', request: input.goal }],
        })),
        solveWork: agent.requests.solveWork.withExecutor(
          async ({ input }) => `answer:${JSON.stringify(input.evidence)}`,
        ),
      },
    }),
    { input: { goal: 'compare tools' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    answer: 'answer:{"E1":"result:compare tools"}',
    evidence: { E1: 'result:compare tools' },
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphReWOOExample();
}
