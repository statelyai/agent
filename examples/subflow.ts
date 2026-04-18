import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const researchSchema = z.object({
  bullets: z.array(z.string()),
});

const draftSchema = z.object({
  draft: z.string(),
});

export function createSubflowExample(
  options: {
    research?: (topic: string) => Promise<z.infer<typeof researchSchema>>;
    write?: (input: {
      topic: string;
      bullets: string[];
    }) => Promise<z.infer<typeof draftSchema>>;
  } = {}
) {
  const childMachine = createAgentMachine({
    id: 'subflow-child',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.object({ bullets: z.array(z.string()) }),
    },
    context: (input) => ({
      topic: input.topic,
      bullets: [] as string[],
    }),
    initial: 'researching',
    states: {
      researching: {
        resultSchema: researchSchema,
        invoke: async ({ context }) =>
          (options.research
            ?? ((topic) =>
              generateExampleObject({
                schema: researchSchema,
                system: 'You research a topic and return concise bullet points.',
                prompt: `Return 2 to 4 concise research bullets about ${topic}.`,
              })))(context.topic),
        onDone: ({ result }) => ({
          target: 'done',
          context: { bullets: result.bullets },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ bullets: context.bullets }),
      },
    },
  });

  return createAgentMachine({
    id: 'subflow-example',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.object({
        bullets: z.array(z.string()),
        draft: z.string().nullable(),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      bullets: [] as string[],
      draft: null as string | null,
    }),
    initial: 'researching',
    states: {
      researching: {
        resultSchema: researchSchema,
        invoke: async ({ context }) => {
          const result = await childMachine.execute(
            childMachine.getInitialState({ topic: context.topic })
          );

          if (result.status !== 'done') {
            throw new Error('Child machine did not finish');
          }

          return {
            bullets: result.output.bullets,
          };
        },
        onDone: ({ result }) => ({
          target: 'writing',
          context: { bullets: result.bullets },
        }),
      },
      writing: {
        resultSchema: draftSchema,
        invoke: async ({ context }) =>
          (options.write
            ?? (({ topic, bullets }) =>
              generateExampleObject({
                schema: draftSchema,
                system: 'You turn research bullets into a short coherent draft.',
                prompt: [
                  `Topic: ${topic}`,
                  'Use these bullets to write a short draft:',
                  ...bullets.map((bullet) => `- ${bullet}`),
                ].join('\n'),
              })))({
            topic: context.topic,
            bullets: context.bullets,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { draft: result.draft },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          bullets: context.bullets,
          draft: context.draft,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Topic');
    const machine = createSubflowExample();
    const result = await machine.execute(machine.getInitialState({ topic }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
