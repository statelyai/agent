import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  decide,
  decideResultSchema,
  startSession,
  type AgentAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  generateExampleObject,
  generateExampleText,
  isMain,
  prompt,
  waitForRunSnapshot,
} from './_run.js';

const draftSchema = z.object({
  replyEmail: z.string(),
});

type EmailTools = {
  lookupContactName: (email: string) => Promise<string>;
  lookupAvailability: () => Promise<string[]>;
  createSignature: (name: string) => Promise<string>;
};

export function createEmailExample(
  options: {
    adapter?: AgentAdapter;
    tools?: Partial<EmailTools>;
    compose?: (
      input: {
        email: string;
        instructions: string;
        clarifications: string[];
        contactName: string;
        availability: string[];
        signature: string;
      }
    ) => Promise<z.infer<typeof draftSchema>>;
  } = {}
) {
  const checkingOptions = {
    askForClarification: {
      description: 'Ask one or more clarifying questions before drafting.',
      schema: z.object({
        questions: z.array(z.string()).min(1),
      }),
    },
    draft: {
      description: 'Draft the email reply now.',
    },
  } as const;

  const adapter =
    options.adapter ??
    (process.env.OPENAI_API_KEY ? createOpenAiDecisionAdapter() : undefined);
  const tools: EmailTools = {
    lookupContactName:
      options.tools?.lookupContactName ??
      (async (email) => {
        const result = await generateExampleObject({
          schema: z.object({ name: z.string() }),
          system: 'Infer a plausible recipient/contact name from an email thread when possible.',
          prompt: `Infer the recipient or contact name from this email. If unclear, return a reasonable professional placeholder.\n\n${email}`,
        });

        return result.name;
      }),
    lookupAvailability:
      options.tools?.lookupAvailability ??
      (async () => {
        const result = await generateExampleObject({
          schema: z.object({
            availability: z.array(z.string()).min(2).max(3),
          }),
          system: 'Produce plausible professional meeting slots.',
          prompt:
            'Return 2 or 3 plausible meeting times for next week, written in a concise natural style.',
        });

        return result.availability;
      }),
    createSignature:
      options.tools?.createSignature ??
      (async (name) =>
        generateExampleText({
          system: 'Write a concise professional email signature.',
          prompt: `Write a short professional sign-off for the sender named ${name}.`,
        })),
  };
  const compose =
    options.compose ??
    (({
      email,
      instructions,
      clarifications,
      contactName,
      availability,
      signature,
    }) =>
      generateExampleObject({
        schema: draftSchema,
        system: 'You write concise professional email replies.',
        prompt: [
          `Incoming email:\n${email}`,
          '',
          `Instructions:\n${instructions}`,
          '',
          `Contact name: ${contactName}`,
          `Availability: ${availability.join(' | ')}`,
          `Signature:\n${signature}`,
          clarifications.length
            ? `Clarifications:\n${clarifications.map((item) => `- ${item}`).join('\n')}`
            : 'Clarifications: none',
          '',
          'Draft the reply email.',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'email-example',
    schemas: {
      input: z.object({
        email: z.string(),
        instructions: z.string(),
      }),
      output: z.object({
        replyEmail: z.string().nullable(),
        clarifications: z.array(z.string()),
      }),
      events: {
        'user.answer': z.object({ answer: z.string() }),
      },
    },
    context: (input) => ({
      email: input.email,
      instructions: input.instructions,
      clarifications: [] as string[],
      questions: [] as string[],
      replyEmail: null as string | null,
    }),
    initial: 'checking',
    states: {
      checking: {
        resultSchema: decideResultSchema(checkingOptions),
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: [
              'Decide whether there is enough information to draft the reply email.',
              'Choose askForClarification only if key scheduling or identity details are missing.',
              '',
              `Email: ${context.email}`,
              `Instructions: ${context.instructions}`,
              `Clarifications: ${context.clarifications.join(' | ') || 'none'}`,
            ].join('\n'),
            options: checkingOptions,
          }),
        onDone: ({ result, context }) => {
          if (
            result.choice === 'askForClarification'
            && context.clarifications.length === 0
          ) {
            return {
              target: 'clarifying',
              context: { questions: result.data.questions },
            };
          }

          return {
            target: 'drafting',
            context: { questions: [] },
          };
        },
      },
      clarifying: {
        on: {
          'user.answer': ({ event, context }) => ({
            target: 'checking',
            context: {
              clarifications: [...context.clarifications, event.answer],
              questions: [],
            },
          }),
        },
      },
      drafting: {
        resultSchema: draftSchema,
        invoke: async ({ context }) => {
          const contactName = await tools.lookupContactName(context.email);
          const availability = await tools.lookupAvailability();
          const signature = await tools.createSignature(contactName);

          return compose({
            email: context.email,
            instructions: context.instructions,
            clarifications: context.clarifications,
            contactName,
            availability,
            signature,
          });
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: { replyEmail: result.replyEmail },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          replyEmail: context.replyEmail,
          clarifications: context.clarifications,
        }),
      },
    },
  });
}

async function main() {
  try {
    const email = await prompt('Incoming email');
    const instructions = await prompt('Instructions');
    const machine = createEmailExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: { email, instructions },
    });

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
          output: snapshot.output,
        });
        break;
      }

      if (snapshot.value === 'clarifying') {
        console.log(snapshot.context.questions.join('\n'));
        const answer = await prompt('Clarification');
        await run.send({ type: 'user.answer', answer });
        continue;
      }

      throw new Error('Email example entered an unexpected pending state.');
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
