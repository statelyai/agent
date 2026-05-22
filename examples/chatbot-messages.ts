import { z } from 'zod';
import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import {
  createAgentMachine,
  type AgentMessage,
} from '../src/index.js';
import {
  closePrompt,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const messageSchema = z.object({
  role: z.string(),
  content: z.string(),
});

const replySchema = z.object({
  message: messageSchema,
});

export function createChatbotMessagesExample(
  reply: (messages: AgentMessage[]) => Promise<z.infer<typeof replySchema>> = (messages) =>
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
      finalMessage: null as z.infer<typeof messageSchema> | null,
      ended: false,
    }),
    messages: [],
    initial: 'waitingForUser',
    states: {
      waitingForUser: {
        on: {
          'messages.user': ({ event, messages }) => ({
            target: 'replying',
            messages: messages.concat(event.message),
          }),
          'messages.end': {
            target: 'done',
            context: { ended: true },
          },
        },
      },
      replying: {
        schemas: { output: replySchema },
        invoke: async ({ messages }) => reply(messages),
        onDone: ({ output, messages }) => ({
          target: 'waitingForUser',
          messages: messages.concat(output.message),
          context: {
            finalMessage: output.message,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context, messages }) => ({
          messages,
          finalMessage: context.finalMessage,
        }),
      },
    },
  });
}

async function main() {
  try {
    const machine = createChatbotMessagesExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
    });
    let lastPrintedAssistantMessage: string | null = null;

    while (true) {
      const snapshot = await waitForRunSnapshot(
        run,
        (nextSnapshot) => nextSnapshot.status !== 'active'
      );

      if (snapshot.status === 'done') {
        console.log({
          status: snapshot.status,
          value: snapshot.value,
          context: snapshot.context,
          messages: snapshot.messages,
          output: snapshot.output,
        });
        break;
      }

      const finalMessage = snapshot.context.finalMessage as
        | z.infer<typeof messageSchema>
        | null;

      if (
        finalMessage?.role === 'assistant'
        && finalMessage.content !== lastPrintedAssistantMessage
      ) {
        console.log(`Assistant: ${finalMessage.content}`);
        lastPrintedAssistantMessage = finalMessage.content;
      }

      const content = await prompt('User (blank to exit)');
      await run.send(
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
