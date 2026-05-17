import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from '../src/index.js';
import {
  closePrompt,
  isMain,
  prompt,
  waitForRunSnapshot,
} from './_run.js';

const leadSchema = z.object({
  id: z.string(),
  company: z.string(),
  contact: z.string(),
});

const scoredLeadSchema = leadSchema.extend({
  score: z.number().min(0).max(100),
  rationale: z.string(),
});

const scoringSchema = z.object({
  scoredLeads: z.array(scoredLeadSchema),
});

const emailDraftSchema = z.object({
  leadId: z.string(),
  draft: z.string(),
});

const emailBatchSchema = z.object({
  drafts: z.array(emailDraftSchema),
});

type Lead = z.infer<typeof leadSchema>;

export function createLeadScoreFlowExample(options: {
  scoreLeads?: (args: {
    leads: Lead[];
    reviewNote: string | null;
  }) => Promise<z.infer<typeof scoringSchema>>;
  writeEmails?: (leads: z.infer<typeof scoredLeadSchema>[]) => Promise<z.infer<typeof emailBatchSchema>>;
} = {}) {
  const scoreLeads =
    options.scoreLeads ??
    (async ({ leads, reviewNote }) => ({
      scoredLeads: leads
        .map((lead, index) => ({
          ...lead,
          score: Math.max(0, 90 - index * 10 - (reviewNote ? 5 : 0)),
          rationale: reviewNote
            ? `Adjusted after review: ${reviewNote}`
            : `Initial score for ${lead.company}`,
        }))
        .sort((a, b) => b.score - a.score),
    }));

  const writeEmails =
    options.writeEmails ??
    (async (leads) => ({
      drafts: leads.map((lead) => ({
        leadId: lead.id,
        draft: `Hi ${lead.contact}, I would love to talk about ${lead.company}.`,
      })),
    }));

  return createAgentMachine({
    id: 'lead-score-flow-example',
    schemas: {
      input: z.object({
        leads: z.array(leadSchema),
      }),
      output: z.object({
        scoredLeads: z.array(scoredLeadSchema),
        topLeads: z.array(scoredLeadSchema),
        emailDrafts: z.array(emailDraftSchema),
        reviewCount: z.number(),
      }),
      events: {
        'review.approve': z.object({}),
        'review.requestChanges': z.object({
          note: z.string(),
        }),
      },
    },
    context: (input) => ({
      leads: input.leads,
      scoredLeads: [] as z.infer<typeof scoredLeadSchema>[],
      topLeads: [] as z.infer<typeof scoredLeadSchema>[],
      emailDrafts: [] as z.infer<typeof emailDraftSchema>[],
      reviewNote: null as string | null,
      reviewCount: 0,
    }),
    initial: 'scoring',
    states: {
      scoring: {
        schemas: { output: scoringSchema },
        invoke: async ({ context }) =>
          scoreLeads({
            leads: context.leads,
            reviewNote: context.reviewNote,
          }),
        onDone: ({ output, context }) => ({
          target: 'reviewing',
          context: {
            scoredLeads: output.scoredLeads,
            topLeads: output.scoredLeads.slice(0, 3),
            reviewNote: null,
            reviewCount: context.reviewCount + 1,
          },
        }),
      },
      reviewing: {
        on: {
          'review.approve': {
            target: 'writing',
          },
          'review.requestChanges': ({ event }) => ({
            target: 'scoring',
            context: {
              reviewNote: event.note,
            },
          }),
        },
      },
      writing: {
        schemas: { output: emailBatchSchema },
        invoke: async ({ context }) => writeEmails(context.scoredLeads),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            emailDrafts: output.drafts,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          scoredLeads: context.scoredLeads,
          topLeads: context.topLeads,
          emailDrafts: context.emailDrafts,
          reviewCount: context.reviewCount,
        }),
      },
    },
  });
}

async function main() {
  try {
    const companies = (await prompt('Comma-separated company names'))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const machine = createLeadScoreFlowExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: {
        leads: companies.map((company, index) => ({
          id: `lead-${index + 1}`,
          company,
          contact: `Contact ${index + 1}`,
        })),
      },
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

      if (snapshot.value === 'reviewing') {
        console.log(snapshot.context.topLeads);
        const answer = await prompt('Type /approve or provide a review note');
        await run.send(
          answer === '/approve'
            ? { type: 'review.approve' }
            : {
              type: 'review.requestChanges',
              note: answer,
            }
        );
        continue;
      }

      throw new Error('Lead score flow entered an unexpected pending state.');
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
