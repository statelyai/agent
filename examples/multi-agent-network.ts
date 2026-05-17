import { z } from 'zod';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type DecideAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const researchParamsSchema = z.object({
  focus: z.string(),
});

const writeParamsSchema = z.object({
  angle: z.string(),
});

const researchNotesSchema = z.object({
  notes: z.array(z.string()).min(2).max(5),
});

const researchHandoffSchema = z.object({
  notes: z.array(z.string()).min(2).max(5),
  handoff: z.string(),
});

const draftSchema = z.object({
  draft: z.string(),
});

const draftHandoffSchema = z.object({
  draft: z.string(),
  handoff: z.string(),
});

export function createMultiAgentNetworkExample(
  options: {
    adapter?: DecideAdapter;
    research?: (args: {
      topic: string;
      focus: string;
    }) => Promise<z.infer<typeof researchNotesSchema>>;
    write?: (args: {
      topic: string;
      notes: string[];
      angle: string;
    }) => Promise<z.infer<typeof draftSchema>>;
  } = {}
) {
  const coordinatorOptions = {
    research: {
      description: 'Send the task to the research specialist.',
      schema: researchParamsSchema,
    },
    write: {
      description: 'Send the task to the writing specialist.',
      schema: writeParamsSchema,
    },
    finalize: {
      description: 'Stop the network and return the current result.',
    },
  } as const;

  const adapter = options.adapter ?? createOpenAiDecisionAdapter();

  const research =
    options.research ??
    ((args: { topic: string; focus: string }) =>
      generateExampleObject({
        schema: researchNotesSchema,
        system: 'You are a research specialist. Return concise notes only.',
        prompt: [
          `Topic: ${args.topic}`,
          `Focus: ${args.focus}`,
          '',
          'Return 2 to 5 concise research notes that help another specialist continue the task.',
        ].join('\n'),
      }));

  const write =
    options.write ??
    ((args: { topic: string; notes: string[]; angle: string }) =>
      generateExampleObject({
        schema: draftSchema,
        system: 'You are a writing specialist. Turn notes into a concise draft.',
        prompt: [
          `Topic: ${args.topic}`,
          `Angle: ${args.angle}`,
          '',
          'Notes:',
          ...args.notes.map((note) => `- ${note}`),
          '',
          'Write a short specialist draft.',
        ].join('\n'),
      }));

  const researchAgent = createAgentMachine({
    id: 'network-research-agent',
    schemas: {
      input: z.object({
        topic: z.string(),
        focus: z.string(),
      }),
      output: z.object({
        notes: z.array(z.string()),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      focus: input.focus,
      notes: [] as string[],
    }),
    initial: 'researching',
    states: {
      researching: {
        schemas: { output: researchNotesSchema },
        invoke: async ({ context }) =>
          research({
            topic: context.topic,
            focus: context.focus,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { notes: output.notes },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          notes: context.notes,
        }),
      },
    },
  });

  const writerAgent = createAgentMachine({
    id: 'network-writer-agent',
    schemas: {
      input: z.object({
        topic: z.string(),
        notes: z.array(z.string()),
        angle: z.string(),
      }),
      output: z.object({
        draft: z.string(),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      notes: input.notes,
      angle: input.angle,
      draft: null as string | null,
    }),
    initial: 'writing',
    states: {
      writing: {
        schemas: { output: draftSchema },
        invoke: async ({ context }) =>
          write({
            topic: context.topic,
            notes: context.notes,
            angle: context.angle,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { draft: output.draft },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          draft: context.draft ?? '',
        }),
      },
    },
  });

  return createAgentMachine({
    id: 'multi-agent-network-example',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.object({
        topic: z.string(),
        notes: z.array(z.string()),
        draft: z.string().nullable(),
        handoffs: z.array(z.string()),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      notes: [] as string[],
      draft: null as string | null,
      handoffs: [] as string[],
    }),
    initial: 'coordinating',
    states: {
      coordinating: {
        schemas: { output: decideResultSchema(coordinatorOptions) },
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: [
              'You are a coordinator deciding which specialist should act next.',
              'Route to research when the task needs more facts.',
              'Route to writing when there are enough notes to draft.',
              'Finalize only when a usable draft already exists.',
              '',
              `Topic: ${context.topic}`,
              context.notes.length
                ? `Notes:\n${context.notes.map((note) => `- ${note}`).join('\n')}`
                : 'Notes: none yet',
              context.draft ? `Current draft:\n${context.draft}` : 'Current draft: none yet',
              context.handoffs.length
                ? `Prior handoffs:\n${context.handoffs.map((handoff, index) => `${index + 1}. ${handoff}`).join('\n')}`
                : 'Prior handoffs: none',
            ].join('\n'),
            options: coordinatorOptions,
          }),
        onDone: ({ output }) => {
          if (output.choice === 'research') {
            return {
              target: 'researching',
              input: {
                focus: output.data.focus ?? 'gather the most useful supporting facts',
              },
            };
          }

          if (output.choice === 'write') {
            return {
              target: 'writing',
              input: {
                angle: output.data.angle ?? 'produce the clearest concise draft',
              },
            };
          }

          return {
            target: 'done',
          };
        },
      },
      researching: {
        schemas: { input: researchParamsSchema, output: researchHandoffSchema },
        invoke: async ({ context, input }) => {
          const result = await researchAgent.execute(
            researchAgent.getInitialState({
              topic: context.topic,
              focus: input.focus,
            })
          );

          if (result.status !== 'done') {
            throw new Error('Research agent did not finish');
          }

          return {
            notes: result.output.notes,
            handoff: `researcher:${input.focus}`,
          };
        },
        onDone: ({ output, context }) => ({
          target: 'coordinating',
          context: {
            notes: output.notes,
            handoffs: [...context.handoffs, output.handoff],
          },
        }),
      },
      writing: {
        schemas: { input: writeParamsSchema, output: draftHandoffSchema },
        invoke: async ({ context, input }) => {
          const result = await writerAgent.execute(
            writerAgent.getInitialState({
              topic: context.topic,
              notes: context.notes,
              angle: input.angle,
            })
          );

          if (result.status !== 'done') {
            throw new Error('Writer agent did not finish');
          }

          return {
            draft: result.output.draft,
            handoff: `writer:${input.angle}`,
          };
        },
        onDone: ({ output, context }) => ({
          target: 'coordinating',
          context: {
            draft: output.draft,
            handoffs: [...context.handoffs, output.handoff],
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          topic: context.topic,
          notes: context.notes,
          draft: context.draft,
          handoffs: context.handoffs,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Topic');
    const machine = createMultiAgentNetworkExample();
    const result = await machine.execute(machine.getInitialState({ topic }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
