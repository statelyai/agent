import { describe, expect, test } from 'vitest';
import { createMeetingAssistantFlowExample } from '../../examples/index.js';

describe('CrewAI meeting assistant flow equivalent', () => {
  test('fans one meeting summary into multiple side effects', async () => {
    const machine = createMeetingAssistantFlowExample({
      extractTasks: async () => ({
        summary: 'Agreed on launch scope and follow-ups.',
        tasks: [
          { title: 'Send launch checklist', owner: 'Ana' },
          { title: 'Prepare customer email', owner: 'Ben' },
        ],
      }),
      addTasksToTrello: async (tasks) => ({
        trelloCardIds: tasks.map((_, index) => `card-${index + 1}`),
      }),
      saveTasksToCsv: async () => ({ csvPath: 'new_tasks.csv' }),
      sendSlackNotification: async () => ({ slackMessageId: 'slack-123' }),
    });

    const result = await machine.execute(
      machine.getInitialState({
        notes: 'Meeting notes go here.',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        summary: 'Agreed on launch scope and follow-ups.',
        tasks: [
          { title: 'Send launch checklist', owner: 'Ana' },
          { title: 'Prepare customer email', owner: 'Ben' },
        ],
        trelloCardIds: ['card-1', 'card-2'],
        csvPath: 'new_tasks.csv',
        slackMessageId: 'slack-123',
      });
    }
  });
});
