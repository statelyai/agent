import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const planSchema = z.object({
  plan: z.array(z.string()).min(1).max(5),
});

const stepResultSchema = z.object({
  result: z.string(),
});

const finalAnswerSchema = z.object({
  answer: z.string(),
});

export function createPlanAndExecuteExample(
  options: {
    plan?: (goal: string) => Promise<z.infer<typeof planSchema>>;
    executeStep?: (args: {
      goal: string;
      step: string;
      priorResults: string[];
    }) => Promise<z.infer<typeof stepResultSchema>>;
    synthesize?: (args: {
      goal: string;
      plan: string[];
      stepResults: string[];
    }) => Promise<z.infer<typeof finalAnswerSchema>>;
  } = {}
) {
  const planner =
    options.plan ??
    ((goal: string) =>
      generateExampleObject({
        schema: planSchema,
        system: 'You are a planner. Break goals into a short actionable sequence.',
        prompt: `Create a short plan with 2 to 5 steps for this goal:\n\n${goal}`,
      }));
  const executeStep =
    options.executeStep ??
    ((args: { goal: string; step: string; priorResults: string[] }) =>
      generateExampleObject({
        schema: stepResultSchema,
        system: 'You execute one plan step at a time and report the result concisely.',
        prompt: [
          `Goal: ${args.goal}`,
          `Current step: ${args.step}`,
          args.priorResults.length
            ? `Prior results:\n${args.priorResults.map((result, index) => `${index + 1}. ${result}`).join('\n')}`
            : 'Prior results: none',
          '',
          'Execute the current step conceptually and return a concise result.',
        ].join('\n'),
      }));
  const synthesize =
    options.synthesize ??
    ((args: { goal: string; plan: string[]; stepResults: string[] }) =>
      generateExampleObject({
        schema: finalAnswerSchema,
        system: 'You synthesize completed plan results into a final answer.',
        prompt: [
          `Goal: ${args.goal}`,
          '',
          'Plan:',
          ...args.plan.map((step, index) => `${index + 1}. ${step}`),
          '',
          'Step results:',
          ...args.stepResults.map((result, index) => `${index + 1}. ${result}`),
          '',
          'Write the final answer.',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'plan-and-execute-example',
    schemas: {
      input: z.object({ goal: z.string() }),
      output: z.object({
        goal: z.string(),
        plan: z.array(z.string()),
        stepResults: z.array(z.string()),
        answer: z.string().nullable(),
      }),
    },
    context: (input) => ({
      goal: input.goal,
      plan: [] as string[],
      stepResults: [] as string[],
      answer: null as string | null,
    }),
    initial: 'planning',
    states: {
      planning: {
        resultSchema: planSchema,
        invoke: async ({ context }) => planner(context.goal),
        onDone: ({ result }) => ({
          target: 'executing',
          context: { plan: result.plan },
          input: { index: 0 } 
        }),
      },
      executing: {
        inputSchema: z.object({
          index: z.number().int().min(0),
        }),
        resultSchema: stepResultSchema,
        invoke: async ({ context, input }) =>
          executeStep({
            goal: context.goal,
            step: context.plan[input.index] ?? '',
            priorResults: context.stepResults,
          }),
        onDone: ({ result, context }) => {
          const nextStepResults = [...context.stepResults, result.result];
          const nextIndex = nextStepResults.length;

          if (nextIndex < context.plan.length) {
            return {
              target: 'executing' as const,
              context: { stepResults: nextStepResults },
              input: { index: nextIndex },
            };
          }

          return {
            target: 'synthesizing' as const,
            context: { stepResults: nextStepResults },
          };
        },
      },
      synthesizing: {
        resultSchema: finalAnswerSchema,
        invoke: async ({ context }) =>
          synthesize({
            goal: context.goal,
            plan: context.plan,
            stepResults: context.stepResults,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { answer: result.answer },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          goal: context.goal,
          plan: context.plan,
          stepResults: context.stepResults,
          answer: context.answer,
        }),
      },
    },
  });
}

async function main() {
  try {
    const goal = await prompt('Goal');
    const machine = createPlanAndExecuteExample();
    console.log(formatResult(await machine.execute(machine.getInitialState({ goal }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
