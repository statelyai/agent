import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const replySchema = z.object({
  message: messageSchema,
});

export function createChatbotMessagesExample(
  reply: (messages: Array<z.infer<typeof messageSchema>>) => Promise<z.infer<typeof replySchema>> = (messages) =>
    generateExampleObject({
      schema: replySchema,
      system: 'You are a concise assistant in a terminal chat.',
      prompt: [
        'Write the next assistant message for this conversation.',
        '',
        ...messages.map((message) => `${message.role}: ${message.content}`),
      ].join('\n'),
    })
) {
  return createAgentMachine({
    id: 'chatbot-messages-example',
    schemas: {
      output: z.object({
        messages: z.array(messageSchema),
        finalMessage: messageSchema.nullable(),
      }),
      events: {
        'messages.user': z.object({
          message: messageSchema.extend({
            role: z.literal('user'),
          }),
        }),
        'messages.end': z.object({}),
      },
    },
    context: () => ({
      messages: [] as Array<z.infer<typeof messageSchema>>,
      finalMessage: null as z.infer<typeof messageSchema> | null,
      ended: false,
    }),
    initial: 'waitingForUser',
    states: {
      waitingForUser: {
        on: {
          'messages.user': ({ event, context }) => ({
            target: 'replying',
            context: {
              messages: [...context.messages, event.message],
            },
          }),
          'messages.end': {
            target: 'done',
            context: { ended: true },
          },
        },
      },
      replying: {
        resultSchema: replySchema,
        invoke: async ({ context }) => reply(context.messages),
        onDone: ({ result, context }) => ({
          target: 'waitingForUser',
          context: {
            messages: [...context.messages, result.message],
            finalMessage: result.message,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          messages: context.messages,
          finalMessage: context.finalMessage,
        }),
      },
    },
  });
}

async function main() {
  try {
    const machine = createChatbotMessagesExample();
    let state = machine.getInitialState();
    let lastPrintedAssistantMessage: string | null = null;

    while (true) {
      const result = await machine.execute(state);

      if (result.status === 'done') {
        break;
      }

      if (result.status !== 'pending') {
        throw new Error('Chatbot messages example entered an unexpected error state.');
      }

      if (
        result.context.finalMessage?.role === 'assistant'
        && result.context.finalMessage.content !== lastPrintedAssistantMessage
      ) {
        console.log(`Assistant: ${result.context.finalMessage.content}`);
        lastPrintedAssistantMessage = result.context.finalMessage.content;
      }

      const content = await prompt('User (blank to exit)');
      state = machine.transition(
        result.state,
        content
          ? {
              type: 'messages.user',
              message: { role: 'user', content },
            }
          : { type: 'messages.end' }
      );
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
