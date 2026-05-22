import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { createLeadScoreFlowExample } from '../../examples/index.js';

describe('CrewAI lead score flow equivalent', () => {
  test('supports human review before generating outreach emails', async () => {
    const machine = createLeadScoreFlowExample({
      scoreLeads: async ({ leads, reviewNote }) => ({
        scoredLeads: leads.map((lead, index) => ({
          ...lead,
          score: 100 - index * 10 - (reviewNote ? 3 : 0),
          rationale: reviewNote ?? 'initial',
        })),
      }),
      writeEmails: async (leads) => ({
        drafts: leads.map((lead) => ({
          leadId: lead.id,
          draft: `Email for ${lead.company}`,
        })),
      }),
    });

    const initial = machine.getInitialState({
      leads: [
        { id: 'lead-1', company: 'Acme', contact: 'Ana' },
        { id: 'lead-2', company: 'Beta', contact: 'Ben' },
        { id: 'lead-3', company: 'Gamma', contact: 'Gia' },
      ],
    });
    const firstPass = await execute(machine, initial);
    expect(firstPass.status).toBe('pending');
    if (firstPass.status !== 'pending') {
      return;
    }

    const rescored = machine.transition(firstPass.state, {
      type: 'review.requestChanges',
      note: 'Prefer companies already asking for demos.',
    });
    const secondPass = await execute(machine, rescored);
    expect(secondPass.status).toBe('pending');
    if (secondPass.status !== 'pending') {
      return;
    }

    const approved = machine.transition(secondPass.state, {
      type: 'review.approve',
    });
    const finalResult = await execute(machine, approved);

    expect(finalResult.status).toBe('done');
    if (finalResult.status === 'done') {
      expect(finalResult.output.reviewCount).toBe(2);
      expect(finalResult.output.topLeads).toHaveLength(3);
      expect(finalResult.output.emailDrafts).toEqual([
        { leadId: 'lead-1', draft: 'Email for Acme' },
        { leadId: 'lead-2', draft: 'Email for Beta' },
        { leadId: 'lead-3', draft: 'Email for Gamma' },
      ]);
    }
  });
});
