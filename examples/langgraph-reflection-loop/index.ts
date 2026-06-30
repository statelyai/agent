import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphReflectionLoopExample() {
  const critiqueSchema = z.object({
    approved: z.boolean(),
    feedback: z.string(),
  });
  let critiqueCount = 0;
  const agent = setupAgent({
    context: z.object({
      prompt: z.string(),
      draft: z.string().nullable(),
      feedback: z.string().nullable(),
      approved: z.boolean(),
    }),
    input: z.object({ prompt: z.string() }),
    output: z.object({ draft: z.string() }),
    requests: {
      writeDraft: {
        schemas: {
          input: z.object({
            prompt: z.string(),
            feedback: z.string().nullable(),
          }),
          output: z.string(),
        },
        model: 'writer',
        prompt: ({ input }) =>
          input.feedback
            ? `${input.prompt}\nRevise: ${input.feedback}`
            : input.prompt,
      },
      critiqueDraft: {
        schemas: {
          input: z.object({ draft: z.string() }),
          output: critiqueSchema,
        },
        model: 'critic',
        prompt: ({ input }) => input.draft,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-reflection',
    context: ({ input }) => ({
      prompt: input.prompt,
      draft: null,
      feedback: null,
      approved: false,
    }),
    initial: 'drafting',
    states: {
      drafting: {
        invoke: {
          src: 'writeDraft',
          input: ({ context }) => ({
            prompt: context.prompt,
            feedback: context.feedback,
          }),
          onDone: ({ output }) => ({
            target: 'critiquing',
            context: { draft: output },
          }),
        },
      },
      critiquing: {
        invoke: {
          src: 'critiqueDraft',
          input: ({ context }) => ({ draft: context.draft ?? '' }),
          onDone: ({ output }) => ({
            target: 'checking',
            context: {
              approved: output.approved,
              feedback: output.feedback,
            },
          }),
        },
      },
      checking: {
        always: ({ context }) =>
          context.approved ? { target: 'done' } : { target: 'drafting' },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.draft ?? '' }),
      },
    },
  });

  const actor = createActor(
    machine.provide({
      actorSources: {
        writeDraft: agent.requests.writeDraft.withExecutor(
          async ({ input }) =>
            `draft:${
              input.feedback
                ? `${input.prompt}\nRevise: ${input.feedback}`
                : input.prompt
            }`,
        ),
        critiqueDraft: agent.requests.critiqueDraft.withExecutor(async () => {
          critiqueCount += 1;
          return {
            approved: critiqueCount > 1,
            feedback: critiqueCount > 1 ? 'ship' : 'add evidence',
          };
        }),
      },
    }),
    { input: { prompt: 'make the case' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    draft: 'draft:make the case\nRevise: add evidence',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphReflectionLoopExample();
}
