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
  isMain,
  prompt,
} from './_run.js';

export function createDecideExample(adapter: DecideAdapter = createOpenAiDecisionAdapter()) {
  const triageOptions = {
    reply: {
      description: 'Reply directly to the customer.',
      schema: z.object({ message: z.string() }),
    },
    askForClarification: {
      description: 'Ask one follow-up question before proceeding.',
      schema: z.object({ question: z.string() }),
    },
    escalate: {
      description: 'Escalate to a human specialist.',
      schema: z.object({ team: z.string() }),
    },
  } as const;

  return createAgentMachine({
    id: 'decide-example',
    schemas: {
      input: z.object({ request: z.string() }),
      output: z.object({
        action: z.string().nullable(),
        payload: z.record(z.string(), z.unknown()).nullable(),
      }),
    },
    context: (input) => ({
      request: input.request,
      action: null as string | null,
      payload: null as Record<string, unknown> | null,
    }),
    initial: 'triage',
    states: {
      triage: {
        schemas: { output: decideResultSchema(triageOptions) },
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: [
              'Choose the best next step for this support request.',
              'Prefer asking a single clarification question when key facts are missing.',
              '',
              `Request: ${context.request}`,
            ].join('\n'),
            options: triageOptions,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            action: output.choice,
            payload: output.data,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          action: context.action,
          payload: context.payload,
        }),
      },
    },
  });
}

async function main() {
  try {
    const request = await prompt('Support request');
    const machine = createDecideExample();

    console.log(formatResult(await machine.execute(machine.getInitialState({ request }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
