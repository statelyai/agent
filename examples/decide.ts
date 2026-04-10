import { z } from 'zod';
import {
  createAgentMachine,
  decide,
  type AgentAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  formatResult,
  isMain,
  prompt,
} from './_run.js';

export function createDecideExample(adapter: AgentAdapter = createOpenAiDecisionAdapter()) {
  return createAgentMachine({
    id: 'decide-example',
    schemas: {
      input: z.object({ request: z.string() }),
    },
    context: (input) => ({
      request: input.request,
      action: null as string | null,
      payload: null as Record<string, unknown> | null,
    }),
    adapter,
    initial: 'triage',
    states: {
      triage: decide({
        model: 'openai/gpt-5.4-nano',
        prompt: ({ context }) => [
          'Choose the best next step for this support request.',
          'Prefer asking a single clarification question when key facts are missing.',
          '',
          `Request: ${context.request}`,
        ].join('\n'),
        options: {
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
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: {
            action: result.choice,
            payload: result.data,
          },
        }),
      }),
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
