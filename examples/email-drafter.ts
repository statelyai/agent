import { z } from 'zod';
import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import {
  appendMessages,
  assistantMessage,
  createAgentMachine,
  type AgentAdapter,
  userMessage,
} from '../src/index.js';
import { createAiSdkAdapter } from '../src/ai-sdk/index.js';
import {
  closePrompt,
  createExampleModel,
  isMain,
  prompt,
} from './_run.js';

const promptAssessmentSchema = z.object({
  satisfied: z.boolean(),
  missing: z.array(z.string()),
  questions: z.array(z.string()),
});

const emailDraftSchema = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
});

type EmailDraft = z.infer<typeof emailDraftSchema>;

function formatDraft(draft: EmailDraft): string {
  return [`To: ${draft.to}`, `Subject: ${draft.subject}`, '', draft.body].join('\n');
}

export function createEmailDrafterExample(
  options: {
    adapter?: AgentAdapter;
    sendEmail?: (draft: EmailDraft) => Promise<void>;
  } = {}
) {
  return createAgentMachine({
    id: 'email-drafter-example',
    adapter: options.adapter ?? createEmailDrafterAdapter(),
    schemas: {
      output: z.object({
        sentEmails: z.array(emailDraftSchema),
      }),
      events: {
        PROMPT_SUBMITTED: z.object({ prompt: z.string() }),
        MORE_INFO: z.object({ details: z.string() }),
        DRAFT_ANYWAY: z.object({}),
        REQUEST_CHANGES: z.object({ changes: z.string() }),
        SEND: z.object({}),
        ANOTHER: z.object({}),
        END: z.object({}),
      },
    },
    externalEvents: [
      'PROMPT_SUBMITTED',
      'MORE_INFO',
      'DRAFT_ANYWAY',
      'REQUEST_CHANGES',
      'SEND',
      'ANOTHER',
      'END',
    ],
    context: () => ({
      prompt: '',
      assessment: null as z.infer<typeof promptAssessmentSchema> | null,
      draft: null as EmailDraft | null,
      changes: null as string | null,
      draftAnyway: false,
      sentEmails: [] as EmailDraft[],
    }),
    initial: 'prompting',
    states: {
      prompting: {
        on: {
          PROMPT_SUBMITTED: ({ event }) => ({
            target: 'evaluating',
            context: {
              prompt: event.prompt,
              assessment: null,
              draft: null,
              changes: null,
              draftAnyway: false,
            },
            messages: [userMessage(event.prompt)],
          }),
        },
      },
      evaluating: {
        model: 'openai/gpt-5.4-nano',
        system:
          'Evaluate an email drafting request. Require recipient/to, subject/purpose, and enough body details. Return concise missing fields and one question per gap.',
        prompt: ({ snapshot }) => snapshot.context.prompt,
        schemas: { output: promptAssessmentSchema },
        onDone: ({ output }) => {
          if (output.satisfied) {
            return {
              target: 'drafting',
              context: { assessment: output },
            };
          }

          return {
            target: 'needsMoreInfo',
            context: { assessment: output },
          };
        },
      },
      needsMoreInfo: {
        on: {
          MORE_INFO: ({ event, context, messages }) => ({
            target: 'evaluating',
            context: {
              prompt: `${context.prompt}\n\n${event.details}`,
              draftAnyway: false,
            },
            messages: appendMessages(messages, userMessage(event.details)),
          }),
          DRAFT_ANYWAY: {
            target: 'drafting',
            context: { draftAnyway: true },
          },
        },
      },
      drafting: {
        model: 'openai/gpt-5.4-nano',
        system: ({ snapshot }) =>
          [
            'Draft a polished email from the request.',
            snapshot.context.draftAnyway
              ? 'Infer reasonable details only because the user chose to draft anyway.'
              : 'Use the provided details without inventing missing essentials.',
            'Keep body useful and concise.',
          ].join('\n'),
        prompt: ({ snapshot }) => snapshot.context.prompt,
        schemas: { output: emailDraftSchema },
        onDone: ({ output, messages }) => ({
          target: 'reviewing',
          context: {
            draft: output,
            changes: null,
          },
          messages: appendMessages(messages, assistantMessage(formatDraft(output))),
        }),
      },
      reviewing: {
        on: {
          REQUEST_CHANGES: ({ event, context, messages }) => ({
            target: 'drafting',
            context: {
              prompt: `${context.prompt}\n\nRevision request: ${event.changes}`,
              changes: event.changes,
              draftAnyway: true,
            },
            messages: appendMessages(
              messages,
              userMessage(`Revision request: ${event.changes}`)
            ),
          }),
          SEND: { target: 'sending' },
        },
      },
      sending: {
        invoke: async ({ context }) => {
          if (context.draft) {
            await options.sendEmail?.(context.draft);
          }
        },
        onDone: ({ context }) => ({
          target: 'sent',
          context: {
            sentEmails: context.draft
              ? [...context.sentEmails, context.draft]
              : context.sentEmails,
          },
        }),
      },
      sent: {
        on: {
          ANOTHER: {
            target: 'prompting',
            context: {
              prompt: '',
              assessment: null,
              draft: null,
              changes: null,
              draftAnyway: false,
            },
          },
          END: { target: 'done' },
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          sentEmails: context.sentEmails,
        }),
      },
    },
  });
}

function createEmailDrafterAdapter(): AgentAdapter {
  const aiAdapter = process.env.OPENAI_API_KEY
    ? createAiSdkAdapter({
        resolveModel: (model) => createExampleModel(model),
      })
    : undefined;

  return {
    async generateText(options) {
      if (aiAdapter?.generateText) {
        try {
          return await aiAdapter.generateText(options);
        } catch (error) {
          console.warn(`AI generation failed; using fallback. ${formatError(error)}`);
        }
      }

      const text = options.prompt ?? options.messages.at(-1)?.content ?? '';

      if (options.outputSchema === promptAssessmentSchema) {
        return assessPromptFallback(text);
      }

      if (options.outputSchema === emailDraftSchema) {
        return draftEmailFallback(text);
      }

      return text;
    },
  };
}

function assessPromptFallback(text: string): z.infer<typeof promptAssessmentSchema> {
  const missing: string[] = [];
  const questions: string[] = [];

  if (!extractRecipient(text)) {
    missing.push('to');
    questions.push('Who should receive it?');
  }

  if (!extractSubject(text)) {
    missing.push('subject');
    questions.push('What subject or purpose should it have?');
  }

  if (!hasBodyDetails(text)) {
    missing.push('body details');
    questions.push('What key points should the body include?');
  }

  return {
    satisfied: missing.length === 0,
    missing,
    questions,
  };
}

function draftEmailFallback(text: string): EmailDraft {
  const to = extractRecipient(text) ?? 'recipient@example.com';
  const subject = extractSubject(text) ?? 'Following up';
  const bodyDetails = text
    .replace(/\s+/g, ' ')
    .replace(/\b(to|subject|about|regarding)\b/gi, '')
    .trim();

  return {
    to,
    subject,
    body: [
      'Hi,',
      '',
      bodyDetails
        ? `I wanted to reach out about ${bodyDetails}.`
        : 'I wanted to reach out with a quick update.',
      '',
      'Please let me know what you think.',
      '',
      'Best,',
    ].join('\n'),
  };
}

function extractRecipient(text: string): string | undefined {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function extractSubject(text: string): string | undefined {
  const match = text.match(/\bsubject\s*[:=-]\s*([^.;\n]+)/i);
  if (match?.[1]) {
    return titleCase(match[1].trim());
  }

  const about = text.match(/\b(?:about|regarding)\s+([^.;\n]+)/i);
  return about?.[1] ? titleCase(about[1].trim()) : undefined;
}

function hasBodyDetails(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return (
    words.length >= 14
    || /because|include|mention|tell|ask|thanks|deadline|meeting/i.test(text)
  );
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function main() {
  try {
    const machine = createEmailDrafterExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
    });

    while (true) {
      const snapshot = await waitForRunSnapshot(
        run,
        (nextSnapshot) => nextSnapshot.status !== 'active'
      );

      if (snapshot.status === 'done') {
        console.log(snapshot.output);
        break;
      }

      if (snapshot.status === 'error') {
        throw new Error(formatError(snapshot.error));
      }

      const events = machine.getEvents(snapshot);

      if ('PROMPT_SUBMITTED' in events) {
        const request = await promptWithEvents('Email draft request', events);
        if (await sendExplicitEvent(run, events, request)) {
          continue;
        }

        await run.send({ type: 'PROMPT_SUBMITTED', prompt: request });
        continue;
      }

      if ('MORE_INFO' in events && 'DRAFT_ANYWAY' in events) {
        console.log(`Missing: ${snapshot.context.assessment?.missing.join(', ')}`);
        console.log(snapshot.context.assessment?.questions.map((q) => `- ${q}`).join('\n'));
        const action = await selectWithEvents(
          'Next',
          [
            { name: 'Add details', value: 'add' },
            { name: 'Draft anyway', value: 'draft' },
          ],
          events
        );
        if (await sendExplicitEvent(run, events, action)) {
          continue;
        }

        if (action.toLowerCase().startsWith('d')) {
          await run.send({ type: 'DRAFT_ANYWAY' });
          continue;
        }

        const details = await prompt('More details');
        await run.send({ type: 'MORE_INFO', details });
        continue;
      }

      if ('REQUEST_CHANGES' in events && 'SEND' in events) {
        if (snapshot.context.draft) {
          console.log(formatDraft(snapshot.context.draft));
        }

        const action = await selectWithEvents(
          'Next',
          [
            { name: 'Request changes', value: 'changes' },
            { name: 'Send', value: 'send' },
          ],
          events
        );
        if (await sendExplicitEvent(run, events, action)) {
          continue;
        }

        if (action.toLowerCase().startsWith('s')) {
          await run.send({ type: 'SEND' });
          continue;
        }

        const changes = await prompt('Requested changes');
        await run.send({ type: 'REQUEST_CHANGES', changes });
        continue;
      }

      if ('ANOTHER' in events && 'END' in events) {
        const another = await selectWithEvents(
          'Send another?',
          [
            { name: 'Yes', value: 'yes' },
            { name: 'No', value: 'no' },
          ],
          events
        );
        if (await sendExplicitEvent(run, events, another)) {
          continue;
        }

        await run.send({
          type: another.toLowerCase().startsWith('y') ? 'ANOTHER' : 'END',
        });
        continue;
      }

      throw new Error('Email drafter entered an unexpected pending state.');
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}

function formatError(error: unknown): string {
  if (
    error
    && typeof error === 'object'
    && 'message' in error
    && typeof error.message === 'string'
  ) {
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

async function promptWithEvents(
  label: string,
  events: Record<string, unknown>
): Promise<string> {
  printAvailableEvents(events);
  return prompt(label);
}

async function selectWithEvents(
  label: string,
  choices: Array<{ name: string; value: string }>,
  events: Record<string, unknown>
): Promise<string> {
  console.log(`${label}:`);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.name}`);
  });
  printAvailableEvents(events);

  const answer = await prompt('Choice');
  const choiceIndex = Number(answer) - 1;
  if (Number.isInteger(choiceIndex) && choices[choiceIndex]) {
    return choices[choiceIndex].value;
  }

  const matchingChoice = choices.find(
    (choice) =>
      choice.value.toLowerCase() === answer.toLowerCase()
      || choice.name.toLowerCase() === answer.toLowerCase()
  );

  return matchingChoice?.value ?? answer;
}

function printAvailableEvents(events: Record<string, unknown>): void {
  console.log(
    `Events: ${Object.keys(events).map((event) => `/${event}`).join(' ')}`
  );
}

async function sendExplicitEvent(
  run: { send: (event: any) => Promise<void> },
  events: Record<string, unknown>,
  value: string
): Promise<boolean> {
  if (!value.startsWith('/')) {
    return false;
  }

  const match = value.match(/^\/([^\s]+)\s*([\s\S]*)$/);
  if (!match) {
    return false;
  }

  const eventType = resolveEventType(events, match[1]!);
  if (!eventType) {
    console.log(`Unknown event. Available: ${Object.keys(events).join(', ')}`);
    return true;
  }

  const payloadText = match[2]!.trim();
  const payload = await resolveEventPayload(eventType, payloadText);
  await run.send({ type: eventType, ...payload });
  return true;
}

function resolveEventType(
  events: Record<string, unknown>,
  input: string
): string | undefined {
  return Object.keys(events).find(
    (eventType) => eventType.toLowerCase() === input.toLowerCase()
  );
}

async function resolveEventPayload(
  eventType: string,
  payloadText: string
): Promise<Record<string, unknown>> {
  if (payloadText.startsWith('{')) {
    return JSON.parse(payloadText);
  }

  switch (eventType) {
    case 'PROMPT_SUBMITTED':
      return { prompt: payloadText || await prompt('prompt') };
    case 'MORE_INFO':
      return { details: payloadText || await prompt('details') };
    case 'REQUEST_CHANGES':
      return { changes: payloadText || await prompt('changes') };
    default:
      return {};
  }
}
