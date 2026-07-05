import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';


export async function runLangGraphMapReduceExample() {
  const agent = setupAgent({
    context: z.object({
      sections: z.array(z.string()),
      summaries: z.array(z.string()),
      final: z.string().nullable(),
    }),
    input: z.object({ sections: z.array(z.string()) }),
    output: z.object({ final: z.string() }),
    actorSources: {
      summarizeAll: createAsyncLogic<string[], { sections: string[] }>({
        run: async ({ input }) =>
          Promise.all(
            input.sections.map(
              async (section: string) => `summary:${section}`,
            ),
          ),
      }),
    },
    requests: {
      reduceSummaries: {
        schemas: {
          input: z.object({ summaries: z.array(z.string()) }),
          output: z.string(),
        },
        model: 'reducer',
        prompt: ({ input }) => input.summaries.join('\n'),
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-map-reduce',
    context: ({ input }) => ({
      sections: input.sections,
      summaries: [],
      final: null,
    }),
    initial: 'mapping',
    states: {
      mapping: {
        invoke: {
          src: 'summarizeAll',
          input: ({ context }) => ({ sections: context.sections }),
          onDone: ({ output }) => ({
            target: 'reducing',
            context: { summaries: output },
          }),
        },
      },
      reducing: {
        invoke: {
          src: 'reduceSummaries',
          input: ({ context }) => ({ summaries: context.summaries }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { final: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ final: context.final ?? '' }),
      },
    },
  });

  const result = await runAgent(machine, {
    input: { sections: ['a', 'b'] },
    generateText: async (request) => ({ output: `reduced:${request.prompt ?? ''}` }),
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    final: 'reduced:summary:a\nsummary:b',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphMapReduceExample();
}
