import { z } from 'zod';
import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import {
  appendMessages,
  assistantMessage,
  createAgentMachine,
  userMessage,
} from '../src/index.js';
import {
  closePrompt,
  generateExampleText,
  isMain,
  prompt,
} from './_run.js';

const generationSchema = z.object({
  rawText: z.string(),
  specYaml: z.string(),
  questions: z.array(z.string()),
  status: z.enum(['needs_user', 'complete']),
});

const validationSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
});

type Generation = z.infer<typeof generationSchema>;

export function createSpecAgentLoopExample(
  options: {
    generate?: (args: {
      specName: string;
      messages: Array<{ role: string; content: string }>;
    }) => Promise<string>;
    validate?: (yaml: string) => z.infer<typeof validationSchema>;
    maxRepairTurns?: number;
  } = {}
) {
  const generate =
    options.generate ??
    (({ specName, messages }) =>
      generateExampleText({
        system: [
          'Write a small YAML spec.',
          'Respond exactly with <SPEC_YAML>, <QUESTIONS>, and <STATUS> tags.',
          'Use <STATUS>complete</STATUS> only when the YAML has no __HOLE__ markers.',
        ].join('\n'),
        prompt: [
          `Spec name: ${specName}`,
          '',
          ...messages.map((message) => `${message.role}: ${message.content}`),
        ].join('\n'),
      }));

  const validate =
    options.validate ??
    ((yaml: string) => {
      const errors: string[] = [];
      if (!yaml.trim()) errors.push('Missing YAML');
      if (/__HOLE__|TODO|TBD|UNKNOWN/i.test(yaml)) errors.push('YAML has holes');
      if (!/^name:/m.test(yaml)) errors.push('Missing name');
      return { ok: errors.length === 0, errors };
    });

  return createAgentMachine({
    id: 'spec-agent-loop-example',
    schemas: {
      input: z.object({
        specName: z.string(),
        prompt: z.string(),
      }),
      events: {
        'user.answer': z.object({ answer: z.string() }),
        'user.accept': z.object({}),
        'user.quit': z.object({}),
      },
      output: z.object({
        specYaml: z.string(),
        accepted: z.boolean(),
      }),
    },
    context: (input) => ({
      specName: input.specName,
      specYaml: '',
      questions: [] as string[],
      status: 'needs_user' as Generation['status'],
      validation: { ok: false, errors: [] as string[] },
      repairTurns: 0,
      maxRepairTurns: options.maxRepairTurns ?? 3,
      accepted: false,
    }),
    messages: (input) => [
      userMessage(`Create an initial spec from this prompt:\n\n${input.prompt}`),
    ],
    initial: 'generating',
    states: {
      generating: {
        schemas: { output: generationSchema },
        invoke: async ({ context, messages }) =>
          parseTaggedResponse(
            await generate({
              specName: context.specName,
              messages,
            })
          ),
        onDone: ({ output, messages }) => ({
          target: output.specYaml ? 'validating' : 'repairing',
          context: {
            specYaml: output.specYaml,
            questions: output.questions,
            status: output.status,
          },
          messages: appendMessages(messages, assistantMessage(output.rawText)),
        }),
      },
      validating: {
        schemas: { output: validationSchema },
        invoke: async ({ context }) => validate(context.specYaml),
        onDone: ({ output }) => ({
          target: 'routing',
          context: { validation: output },
        }),
      },
      routing: {
        always: ({ context, messages }) => {
          if (context.validation.ok && context.status === 'complete') {
            return { target: 'awaitingAcceptance' };
          }

          if (!context.validation.ok && context.status === 'complete') {
            return {
              target:
                context.repairTurns < context.maxRepairTurns
                  ? 'generating'
                  : 'awaitingUser',
              context: { repairTurns: context.repairTurns + 1 },
              messages: appendMessages(
                messages,
                userMessage(
                  [
                    'You marked the spec complete, but deterministic validation failed.',
                    ...context.validation.errors.map((error) => `- ${error}`),
                  ].join('\n')
                )
              ),
            };
          }

          return { target: 'awaitingUser' };
        },
      },
      repairing: {
        always: ({ context, messages }) => ({
          target:
            context.repairTurns < context.maxRepairTurns
              ? 'generating'
              : 'awaitingUser',
          context: { repairTurns: context.repairTurns + 1 },
          messages: appendMessages(
            messages,
            userMessage('Return the full YAML spec using the required tags.')
          ),
        }),
      },
      awaitingUser: {
        on: {
          'user.answer': ({ event, messages }) => ({
            target: 'generating',
            context: { repairTurns: 0 },
            messages: appendMessages(
              messages,
              userMessage(`User answered/refined:\n\n${event.answer}`)
            ),
          }),
          'user.quit': { target: 'done' },
        },
      },
      awaitingAcceptance: {
        on: {
          'user.accept': {
            target: 'done',
            context: { accepted: true },
          },
          'user.answer': ({ event, messages }) => ({
            target: 'generating',
            messages: appendMessages(
              messages,
              userMessage(`Spec validates, but refine:\n\n${event.answer}`)
            ),
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          specYaml: context.specYaml,
          accepted: context.accepted,
        }),
      },
    },
  });
}

function parseTaggedResponse(text: string): Generation {
  const specYaml = text.match(/<SPEC_YAML>([\s\S]*?)<\/SPEC_YAML>/)?.[1]?.trim() ?? '';
  const questionText = text.match(/<QUESTIONS>([\s\S]*?)<\/QUESTIONS>/)?.[1]?.trim() ?? '';
  const statusRaw = text.match(/<STATUS>([\s\S]*?)<\/STATUS>/)?.[1]?.trim();

  return {
    rawText: text.trim(),
    specYaml,
    questions: questionText
      .split('\n')
      .map((line) => line.replace(/^[-*\d. )]+/, '').trim())
      .filter(Boolean),
    status: statusRaw === 'complete' ? 'complete' : 'needs_user',
  };
}

async function main() {
  try {
    const specName = await prompt('Spec name');
    const initialPrompt = await prompt('Describe the spec');
    const machine = createSpecAgentLoopExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: { specName, prompt: initialPrompt },
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

      console.log({
        value: snapshot.value,
        validation: snapshot.context.validation,
        questions: snapshot.context.questions,
      });

      if (snapshot.value === 'awaitingAcceptance') {
        const answer = await prompt('Accept? [Y/n]');
        await run.send(
          !answer || /^y(es)?$/i.test(answer)
            ? { type: 'user.accept' }
            : { type: 'user.answer', answer }
        );
        continue;
      }

      const answer = await prompt('Answer, refine, or /quit');
      await run.send(
        answer === '/quit'
          ? { type: 'user.quit' }
          : { type: 'user.answer', answer }
      );
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
