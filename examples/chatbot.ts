import { z } from 'zod';
import { createAgentMachine, decide, type AgentAdapter } from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const replySchema = z.object({
  response: z.string(),
});

export function createChatbotExample(
  options: {
    adapter?: AgentAdapter;
    reply?: (transcript: string[]) => Promise<z.infer<typeof replySchema>>;
  } = {}
) {
  const adapter =
    options.adapter ??
    (process.env.OPENAI_API_KEY ? createOpenAiDecisionAdapter() : undefined);
  const reply =
    options.reply ??
    ((transcript: string[]) =>
      generateExampleObject({
        schema: replySchema,
        system: 'You are a concise, helpful assistant in a terminal chat.',
        prompt: [
          'Write the assistant reply for the conversation below.',
          'Keep it short and directly responsive.',
          '',
          transcript.join('\n'),
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'chatbot-example',
    schemas: {
      events: {
        'user.message': z.object({ message: z.string() }),
        'user.exit': z.object({}),
      },
    },
    context: () => ({
      transcript: [] as string[],
      lastUserMessage: null as string | null,
      lastAssistantMessage: null as string | null,
      ended: false,
    }),
    adapter,
    initial: 'listening',
    states: {
      listening: {
        on: {
          'user.message': ({ event, context }) => ({
            target: 'deciding',
            context: {
              lastUserMessage: event.message,
              transcript: [...context.transcript, `User: ${event.message}`],
            },
          }),
          'user.exit': {
            target: 'done',
            context: { ended: true },
          },
        },
      },
      deciding: decide({
        model: 'openai/gpt-5.4-nano',
        prompt: ({ context }) =>
          [
            'Decide whether the assistant should answer or end the conversation.',
            'End only when the user is clearly saying goodbye or asking to stop.',
            '',
            (context as { transcript: string[] }).transcript.join('\n'),
          ].join('\n'),
        options: {
          respond: { description: 'Reply to the user and continue chatting.' },
          end: { description: 'End the conversation now.' },
        },
        onDone: ({ result }) => ({
          target: result.choice === 'end' ? 'done' : 'replying',
          context: result.choice === 'end' ? { ended: true } : {},
        }),
      }),
      replying: {
        resultSchema: replySchema,
        invoke: async ({ context }) => reply(context.transcript),
        onDone: ({ result, context }) => ({
          target: 'listening',
          context: {
            lastAssistantMessage: result.response,
            transcript: [...context.transcript, `Assistant: ${result.response}`],
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          transcript: context.transcript,
          ended: context.ended,
          lastAssistantMessage: context.lastAssistantMessage,
        }),
      },
    },
  });
}

async function main() {
  try {
    const machine = createChatbotExample();
    let state = machine.getInitialState();
    let lastPrintedAssistantMessage: string | null = null;

    while (true) {
      const result = await machine.execute(state);

      if (result.status === 'done') {
        if (
          result.output &&
          typeof result.output === 'object' &&
          'lastAssistantMessage' in result.output &&
          result.output.lastAssistantMessage &&
          result.output.lastAssistantMessage !== lastPrintedAssistantMessage
        ) {
          console.log(`Assistant: ${result.output.lastAssistantMessage}`);
        }
        console.log(formatResult(result));
        break;
      }

      if (result.status !== 'pending') {
        throw new Error('Chatbot example entered an unexpected error state.');
      }

       if (
        result.context.lastAssistantMessage &&
        result.context.lastAssistantMessage !== lastPrintedAssistantMessage
      ) {
        console.log(`Assistant: ${result.context.lastAssistantMessage}`);
        lastPrintedAssistantMessage = result.context.lastAssistantMessage;
      }

      const message = await prompt('User (blank to exit)');
      state = machine.transition(
        result.state,
        message
          ? { type: 'user.message', message }
          : { type: 'user.exit' }
      );
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
