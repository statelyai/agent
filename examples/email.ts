import { z } from 'zod';
import { createAgentMachine, decide, type AgentAdapter } from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  formatResult,
  generateExampleObject,
  generateExampleText,
  isMain,
  prompt,
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
    adapter,
    initial: 'checking',
    states: {
      checking: decide({
        model: 'openai/gpt-5.4-nano',
        prompt: ({ context }) => { // why is this Record<string, unknown> instead of a specific type?
          const emailContext = context as {
            email: string;
            instructions: string;
            clarifications: string[];
          };

          return [
            'Decide whether there is enough information to draft the reply email.',
            'Choose askForClarification only if key scheduling or identity details are missing.',
            '',
            `Email: ${emailContext.email}`,
            `Instructions: ${emailContext.instructions}`,
            `Clarifications: ${emailContext.clarifications.join(' | ') || 'none'}`,
          ].join('\n');
        },
        options: {
          askForClarification: {
            description: 'Ask one or more clarifying questions before drafting.',
            schema: z.object({
              questions: z.array(z.string()).min(1),
            }),
          },
          draft: {
            description: 'Draft the email reply now.',
          },
        },
        onDone: ({ result, context }) => {
          const emailContext = context as { clarifications: string[] };

          return ({
          target:
            result.choice === 'askForClarification' &&
            emailContext.clarifications.length === 0
              ? 'clarifying'
              : 'drafting',
          context:
            result.choice === 'askForClarification' &&
            emailContext.clarifications.length === 0
              ? { questions: result.data.questions }
              : { questions: [] },
          });
        },
      }),
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
    let state = machine.getInitialState({ email, instructions });

    while (true) {
      const result = await machine.execute(state);

      if (result.status === 'done') {
        console.log(formatResult(result));
        break;
      }

      if (result.status !== 'pending') {
        throw new Error('Email example entered an unexpected error state.');
      }

      if (result.value === 'clarifying') {
        console.log(result.context.questions.join('\n'));
        const answer = await prompt('Clarification');
        state = machine.transition(result.state, { type: 'user.answer', answer });
        continue;
      }

      state = result.state;
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
