import { describe, expect, test } from 'vitest';
import { runEmailAutoResponderFlowExample } from '../../examples/index.js';

describe('CrewAI email auto responder flow equivalent', () => {
  test('processes new emails and restores the same durable snapshot', async () => {
    const result = await runEmailAutoResponderFlowExample(
      [
        {
          id: 'email-1',
          sender: 'buyer@example.com',
          subject: 'Pricing question',
          body: 'Can you send pricing details?',
        },
        {
          id: 'email-2',
          sender: 'founder@example.com',
          subject: 'Partnership',
          body: 'Interested in discussing a partnership.',
        },
      ],
      {
        createDraft: async (email) => ({
          draft: `Draft for ${email.subject}`,
        }),
      }
    );

    expect(result.snapshot).toEqual(result.restoredSnapshot);
    expect(result.snapshot).toEqual(
      expect.objectContaining({
        value: 'waiting',
        status: 'pending',
      })
    );
    expect(result.snapshot.context.processedIds).toEqual(['email-1', 'email-2']);
    expect(result.snapshot.context.drafts).toEqual({
      'email-1': 'Draft for Pricing question',
      'email-2': 'Draft for Partnership',
    });
  });
});
