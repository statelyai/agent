import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from '../src/index.js';
import { createExampleModel } from './_run.js';

const uiMessagesSchema = z.object({
  messages: z.array(z.custom<UIMessage>()),
});

const streamedTextSchema = z.object({
  text: z.string(),
});

const notificationSchema = z.object({
  message: z.string(),
  level: z.enum(['info', 'warning', 'error']),
});

const sourceSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string(),
});

export type AgentUiMessage = UIMessage<
  unknown,
  {
    notification: z.infer<typeof notificationSchema>;
  }
>;

export function createNextAiSdkUiRoute(options: {
  streamReply?: (args: {
    messages: UIMessage[];
    onDelta: (delta: string) => void;
  }) => Promise<z.infer<typeof streamedTextSchema>>;
} = {}) {
  const streamReply =
    options.streamReply ??
    (async ({
      messages,
      onDelta,
    }: {
      messages: UIMessage[];
      onDelta: (delta: string) => void;
    }) => {
      const result = streamText({
        model: createExampleModel('openai/gpt-5.4-nano'),
        messages: await convertToModelMessages(messages),
      });

      for await (const delta of result.textStream) {
        onDelta(delta);
      }

      return {
        text: await result.text,
      };
    });

  const machine = createAgentMachine({
    id: 'next-ai-sdk-ui-example',
    schemas: {
      input: uiMessagesSchema,
      output: streamedTextSchema,
      emitted: {
        notification: notificationSchema,
        source: sourceSchema,
        textPart: z.object({
          delta: z.string(),
        }),
      },
      events: {
        begin: z.object({}),
      },
    },
    context: (input) => ({
      messages: input.messages,
      finalText: '',
    }),
    initial: 'ready',
    states: {
      ready: {
        on: {
          begin: {
            target: 'drafting',
          },
        },
      },
      drafting: {
        schemas: { output: streamedTextSchema },
        invoke: async ({ context }, enq) => {
          enq.emit({
            type: 'notification',
            message: 'Drafting reply...',
            level: 'info',
          });
          enq.emit({
            type: 'source',
            id: 'agent-docs',
            url: 'https://stately.ai/docs/agents',
            title: 'Stately Agent documentation',
          });

          return streamReply({
            messages: context.messages,
            onDelta: (delta) => {
              enq.emit({
                type: 'textPart',
                delta,
              });
            },
          });
        },
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            finalText: output.text,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          text: context.finalText,
        }),
      },
    },
  });

  return {
    async POST(request: Request): Promise<Response> {
      const { messages } = uiMessagesSchema.parse(await request.json());

      const stream = createUIMessageStream({
        originalMessages: messages,
        execute: async ({ writer }) => {
          const run = await startSession(machine, {
            store: createMemoryRunStore(),
            input: { messages },
          });

          const textId = 'assistant-response';
          let textStarted = false;

          const offNotification = run.on('notification', (event) => {
            writer.write({
              type: 'data-notification',
              data: {
                message: event.message,
                level: event.level,
              },
              transient: true,
            });
          });
          const offSource = run.on('source', (event) => {
            writer.write(({
              type: 'source',
              value: {
                type: 'source',
                sourceType: 'url',
                id: event.id,
                url: event.url,
                title: event.title,
              },
            } as unknown) as never);
          });
          const offTextPart = run.on('textPart', (event) => {
            if (!textStarted) {
              writer.write({
                type: 'text-start',
                id: textId,
              });
              textStarted = true;
            }

            writer.write({
              type: 'text-delta',
              id: textId,
              delta: event.delta,
            });
          });

          try {
            await run.send({ type: 'begin' });
          } finally {
            offNotification();
            offSource();
            offTextPart();
          }

          if (textStarted) {
            writer.write({
              type: 'text-end',
              id: textId,
            });
          }
        },
      });

      return createUIMessageStreamResponse({ stream });
    },
  };
}
