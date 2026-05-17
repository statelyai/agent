import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const modeSchema = z.enum(['research', 'draft']);

const researchSchema = z.object({
  bullets: z.array(z.string()),
});

const draftSchema = z.object({
  draft: z.string(),
});

export function createConditionalSubflowExample(
  options: {
    research?: (topic: string) => Promise<z.infer<typeof researchSchema>>;
    draft?: (args: {
      topic: string;
      bullets: string[];
    }) => Promise<z.infer<typeof draftSchema>>;
  } = {}
) {
  const researchMachine = createAgentMachine({
    id: 'conditional-subflow-research',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: researchSchema,
    },
    context: (input) => ({
      topic: input.topic,
      bullets: [] as string[],
    }),
    initial: 'researching',
    states: {
      researching: {
        schemas: { output: researchSchema },
        invoke: async ({ context }) =>
          (options.research
            ?? ((topic) =>
              generateExampleObject({
                schema: researchSchema,
                system: 'Return concise research bullets.',
                prompt: `Return 2 to 4 bullets about ${topic}.`,
              })))(context.topic),
        onDone: ({ output }) => ({
          target: 'done',
          context: { bullets: output.bullets },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ bullets: context.bullets }),
      },
    },
  });

  const draftMachine = createAgentMachine({
    id: 'conditional-subflow-draft',
    schemas: {
      input: z.object({
        topic: z.string(),
        bullets: z.array(z.string()),
      }),
      output: draftSchema,
    },
    context: (input) => ({
      topic: input.topic,
      bullets: input.bullets,
      draft: null as string | null,
    }),
    initial: 'drafting',
    states: {
      drafting: {
        schemas: { output: draftSchema },
        invoke: async ({ context }) =>
          (options.draft
            ?? (({ topic, bullets }) =>
              generateExampleObject({
                schema: draftSchema,
                system: 'Turn bullets into a short draft.',
                prompt: [
                  `Topic: ${topic}`,
                  'Bullets:',
                  ...bullets.map((bullet) => `- ${bullet}`),
                ].join('\n'),
              })))({
            topic: context.topic,
            bullets: context.bullets,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { draft: output.draft },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.draft ?? '' }),
      },
    },
  });

  return createAgentMachine({
    id: 'conditional-subflow-example',
    schemas: {
      input: z.object({
        topic: z.string(),
        mode: modeSchema,
        bullets: z.array(z.string()).optional(),
      }),
      output: z.object({
        mode: modeSchema,
        bullets: z.array(z.string()),
        draft: z.string().nullable(),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      mode: input.mode,
      bullets: input.bullets ?? [],
      draft: null as string | null,
    }),
    initial: ({ context }) =>
      context.mode === 'research'
        ? { target: 'researching' }
        : { target: 'drafting', input: { bullets: context.bullets } },
    states: {
      researching: {
        schemas: { output: researchSchema },
        invoke: async ({ context }) => {
          const result = await researchMachine.execute(
            researchMachine.getInitialState({ topic: context.topic })
          );

          if (result.status !== 'done') {
            throw new Error('Research subflow did not finish');
          }

          return result.output;
        },
        onDone: ({ output }) => ({
          target: 'done',
          context: { bullets: output.bullets },
        }),
      },
      drafting: {
        schemas: { input: z.object({
          bullets: z.array(z.string()),
        }), output: draftSchema },
        invoke: async ({ context, input }) => {
          const result = await draftMachine.execute(
            draftMachine.getInitialState({
              topic: context.topic,
              bullets: input.bullets,
            })
          );

          if (result.status !== 'done') {
            throw new Error('Draft subflow did not finish');
          }

          return result.output;
        },
        onDone: ({ output }) => ({
          target: 'done',
          context: { draft: output.draft },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          mode: context.mode,
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
    const modeInput = await prompt('Mode (research/draft)');
    const mode = modeInput === 'draft' ? 'draft' : 'research';
    const machine = createConditionalSubflowExample();
    const result = await machine.execute(
      machine.getInitialState({ topic, mode })
    );

    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
