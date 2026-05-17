import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const taskSchema = z.object({
  title: z.string(),
  owner: z.string(),
});

const extractionSchema = z.object({
  summary: z.string(),
  tasks: z.array(taskSchema),
});

const fanOutSchema = z.object({
  trelloCardIds: z.array(z.string()),
  csvPath: z.string(),
  slackMessageId: z.string(),
});

export function createMeetingAssistantFlowExample(options: {
  extractTasks?: (notes: string) => Promise<z.infer<typeof extractionSchema>>;
  addTasksToTrello?: (tasks: z.infer<typeof taskSchema>[]) => Promise<{ trelloCardIds: string[] }>;
  saveTasksToCsv?: (tasks: z.infer<typeof taskSchema>[]) => Promise<{ csvPath: string }>;
  sendSlackNotification?: (args: {
    summary: string;
    tasks: z.infer<typeof taskSchema>[];
  }) => Promise<{ slackMessageId: string }>;
} = {}) {
  const extractTasks =
    options.extractTasks ??
    ((notes: string) =>
      generateExampleObject({
        schema: extractionSchema,
        system: 'Extract a concise meeting summary and explicit action items.',
        prompt: notes,
      }));

  const addTasksToTrello =
    options.addTasksToTrello ??
    (async (tasks) => ({
      trelloCardIds: tasks.map((_, index) => `card-${index + 1}`),
    }));

  const saveTasksToCsv =
    options.saveTasksToCsv ??
    (async () => ({
      csvPath: 'new_tasks.csv',
    }));

  const sendSlackNotification =
    options.sendSlackNotification ??
    (async () => ({
      slackMessageId: 'slack-message-1',
    }));

  return createAgentMachine({
    id: 'meeting-assistant-flow-example',
    schemas: {
      input: z.object({
        notes: z.string(),
      }),
      output: z.object({
        summary: z.string().nullable(),
        tasks: z.array(taskSchema),
        trelloCardIds: z.array(z.string()),
        csvPath: z.string().nullable(),
        slackMessageId: z.string().nullable(),
      }),
    },
    context: (input) => ({
      notes: input.notes,
      summary: null as string | null,
      tasks: [] as z.infer<typeof taskSchema>[],
      trelloCardIds: [] as string[],
      csvPath: null as string | null,
      slackMessageId: null as string | null,
    }),
    initial: 'extracting',
    states: {
      extracting: {
        schemas: { output: extractionSchema },
        invoke: async ({ context }) => extractTasks(context.notes),
        onDone: ({ output }) => ({
          target: 'dispatching',
          context: {
            summary: output.summary,
            tasks: output.tasks,
          },
        }),
      },
      dispatching: {
        schemas: { output: fanOutSchema },
        invoke: async ({ context }) => {
          const [trello, csv, slack] = await Promise.all([
            addTasksToTrello(context.tasks),
            saveTasksToCsv(context.tasks),
            sendSlackNotification({
              summary: context.summary ?? '',
              tasks: context.tasks,
            }),
          ]);

          return {
            trelloCardIds: trello.trelloCardIds,
            csvPath: csv.csvPath,
            slackMessageId: slack.slackMessageId,
          };
        },
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            trelloCardIds: output.trelloCardIds,
            csvPath: output.csvPath,
            slackMessageId: output.slackMessageId,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          summary: context.summary,
          tasks: context.tasks,
          trelloCardIds: context.trelloCardIds,
          csvPath: context.csvPath,
          slackMessageId: context.slackMessageId,
        }),
      },
    },
  });
}

async function main() {
  try {
    const notes = await prompt('Meeting notes');
    const machine = createMeetingAssistantFlowExample();
    const result = await machine.execute(machine.getInitialState({ notes }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
