import { z } from 'zod';
import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type DecideAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const replySchema = z.object({
  response: z.string(),
});

export function createChatbotExample(
  options: {
    adapter?: DecideAdapter;
    reply?: (transcript: string[]) => Promise<z.infer<typeof replySchema>>;
  } = {}
) {
  const decisionOptions = {
    respond: { description: 'Reply to the user and continue chatting.' },
    end: { description: 'End the conversation now.' },
  } as const;

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
      output: z.object({
        transcript: z.array(z.string()),
        ended: z.boolean(),
        lastAssistantMessage: z.string().nullable(),
      }),
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
      deciding: {
        schemas: { output: decideResultSchema(decisionOptions) },
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: [
              'Decide whether the assistant should answer or end the conversation.',
              'End only when the user is clearly saying goodbye or asking to stop.',
              '',
              context.transcript.join('\n'),
            ].join('\n'),
            options: decisionOptions,
          }),
        onDone: ({ output }) => ({
          target: output.choice === 'end' ? 'done' : 'replying',
          context: output.choice === 'end' ? { ended: true } : {},
        }),
      },
      replying: {
        schemas: { output: replySchema },
        invoke: async ({ context }) => reply(context.transcript),
        onDone: ({ output, context }) => ({
          target: 'listening',
          context: {
            lastAssistantMessage: output.response,
            transcript: [...context.transcript, `Assistant: ${output.response}`],
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
        if (
          snapshot.output &&
          typeof snapshot.output === 'object' &&
          'lastAssistantMessage' in snapshot.output &&
          snapshot.output.lastAssistantMessage &&
          snapshot.output.lastAssistantMessage !== lastPrintedAssistantMessage
        ) {
          console.log(`Assistant: ${snapshot.output.lastAssistantMessage}`);
        }
        console.log({
          status: snapshot.status,
          value: snapshot.value,
          context: snapshot.context,
          output: snapshot.output,
        });
        break;
      }

      if (
        snapshot.context.lastAssistantMessage &&
        snapshot.context.lastAssistantMessage !== lastPrintedAssistantMessage
      ) {
        console.log(`Assistant: ${snapshot.context.lastAssistantMessage}`);
        lastPrintedAssistantMessage = snapshot.context.lastAssistantMessage;
      }

      const message = await prompt('User (blank to exit)');
      await run.send(
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
