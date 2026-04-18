import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const rewooPlanSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().regex(/^E\d+$/),
        instruction: z.string(),
        input: z.string(),
      })
    )
    .min(1)
    .max(5),
});

const rewooStepResultSchema = z.object({
  result: z.string(),
});

const rewooAnswerSchema = z.object({
  answer: z.string(),
});

type RewooPlan = z.infer<typeof rewooPlanSchema>;
type RewooStep = RewooPlan['steps'][number];

function resolveStepInput(
  template: string,
  resultsById: Record<string, string>
): string {
  return template.replace(/#(E\d+)/g, (_match, id: string) => resultsById[id] ?? '');
}

export function createRewooExample(
  options: {
    plan?: (objective: string) => Promise<RewooPlan>;
    executeStep?: (args: {
      objective: string;
      step: RewooStep;
      resolvedInput: string;
      resultsById: Record<string, string>;
    }) => Promise<z.infer<typeof rewooStepResultSchema>>;
    solve?: (args: {
      objective: string;
      steps: RewooPlan['steps'];
      resultsById: Record<string, string>;
    }) => Promise<z.infer<typeof rewooAnswerSchema>>;
  } = {}
) {
  const plan =
    options.plan ??
    ((objective: string) =>
      generateExampleObject({
        schema: rewooPlanSchema,
        system: [
          'You are a ReWOO-style planner.',
          'Produce a short sequence of executable steps.',
          'Each step must have an id like E1, E2, E3.',
          'Later step inputs may reference earlier outputs using #E1, #E2, etc.',
        ].join('\n'),
        prompt: `Create a compact executable plan for this objective:\n\n${objective}`,
      }));

  const executeStep =
    options.executeStep ??
    ((args: {
      objective: string;
      step: RewooStep;
      resolvedInput: string;
      resultsById: Record<string, string>;
    }) =>
      generateExampleObject({
        schema: rewooStepResultSchema,
        system: 'You execute one specialist step at a time and return a concise result.',
        prompt: [
          `Objective: ${args.objective}`,
          `Step id: ${args.step.id}`,
          `Instruction: ${args.step.instruction}`,
          `Resolved input: ${args.resolvedInput}`,
          Object.keys(args.resultsById).length
            ? `Prior results:\n${Object.entries(args.resultsById)
                .map(([id, value]) => `${id}: ${value}`)
                .join('\n')}`
            : 'Prior results: none',
        ].join('\n'),
      }));

  const solve =
    options.solve ??
    ((args: {
      objective: string;
      steps: RewooPlan['steps'];
      resultsById: Record<string, string>;
    }) =>
      generateExampleObject({
        schema: rewooAnswerSchema,
        system: 'You synthesize completed step results into a direct final answer.',
        prompt: [
          `Objective: ${args.objective}`,
          '',
          'Completed steps:',
          ...args.steps.map((step) => `${step.id}. ${step.instruction}`),
          '',
          'Results:',
          ...Object.entries(args.resultsById).map(([id, value]) => `${id}: ${value}`),
          '',
          'Write the final answer.',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'rewoo-example',
    schemas: {
      input: z.object({ objective: z.string() }),
      output: z.object({
        objective: z.string(),
        steps: rewooPlanSchema.shape.steps,
        resultsById: z.record(z.string(), z.string()),
        answer: z.string().nullable(),
      }),
    },
    context: (input) => ({
      objective: input.objective,
      steps: [] as RewooPlan['steps'],
      resultsById: {} as Record<string, string>,
      answer: null as string | null,
    }),
    initial: 'planning',
    states: {
      planning: {
        resultSchema: rewooPlanSchema,
        invoke: async ({ context }) => plan(context.objective),
        onDone: ({ result }) => ({
          target: 'executing',
          context: { steps: result.steps },
          input: { index: 0 },
        }),
      },
      executing: {
        inputSchema: z.object({
          index: z.number().int().min(0),
        }),
        resultSchema: z.object({
          stepId: z.string(),
          result: z.string(),
        }),
        invoke: async ({ context, input }) => {
          const step = context.steps[input.index];

          if (!step) {
            throw new Error(`Missing step at index ${input.index}`);
          }

          const resolvedInput = resolveStepInput(step.input, context.resultsById);
          const outcome = await executeStep({
            objective: context.objective,
            step,
            resolvedInput,
            resultsById: context.resultsById,
          });

          return {
            stepId: step.id,
            result: outcome.result,
          };
        },
        onDone: ({ result, context }) => {
          const nextResultsById = {
            ...context.resultsById,
            [result.stepId]: result.result,
          };
          const nextIndex = Object.keys(nextResultsById).length;

          if (nextIndex < context.steps.length) {
            return {
              target: 'executing',
              context: { resultsById: nextResultsById },
              input: { index: nextIndex },
            };
          }

          return {
            target: 'solving',
            context: { resultsById: nextResultsById },
          };
        },
      },
      solving: {
        resultSchema: rewooAnswerSchema,
        invoke: async ({ context }) =>
          solve({
            objective: context.objective,
            steps: context.steps,
            resultsById: context.resultsById,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { answer: result.answer },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          objective: context.objective,
          steps: context.steps,
          resultsById: context.resultsById,
          answer: context.answer,
        }),
      },
    },
  });
}

async function main() {
  try {
    const objective = await prompt('Objective');
    const machine = createRewooExample();
    const result = await machine.execute(machine.getInitialState({ objective }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
