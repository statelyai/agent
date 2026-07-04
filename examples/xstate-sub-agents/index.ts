import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, toPromise } from 'xstate';
import { setupAgent } from '../../src/index.js';
const models = {
  "researcher": "researcher",
  "writer": "writer",
  "editor": "editor",
} as const;


const sourcesOutputSchema = z.object({ sources: z.array(z.string()) });
const researchOutputSchema = z.object({ notes: z.string() });
const outlineOutputSchema = z.object({ outline: z.array(z.string()) });
const draftOutputSchema = z.object({ draft: z.string() });
const reviewOutputSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
});
const finalOutputSchema = z.object({ final: z.string() });

function createResearchAgent() {
  const agent = setupAgent({
    models,
    context: z.object({
      topic: z.string(),
      sources: z.array(z.string()),
      notes: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: researchOutputSchema,
    requests: {
      gatherSources: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: sourcesOutputSchema,
        },
        model: 'researcher',
        prompt: ({ input }) => `Find credible sources for: ${input.topic}`,
      },
      summarizeSources: {
        schemas: {
          input: z.object({
            topic: z.string(),
            sources: z.array(z.string()),
          }),
          output: researchOutputSchema,
        },
        model: 'researcher',
        prompt: ({ input }) =>
          `Summarize ${input.topic} using these sources: ${input.sources.join(', ')}`,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'research-agent',
    context: ({ input }) => ({ topic: input.topic, sources: [], notes: null }),
    initial: 'gatheringSources',
    states: {
      gatheringSources: {
        invoke: {
          src: 'gatherSources',
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }) => ({
            target: 'summarizing',
            context: { sources: output.sources },
          }),
        },
      },
      summarizing: {
        invoke: {
          src: 'summarizeSources',
          input: ({ context }) => ({
            topic: context.topic,
            sources: context.sources,
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { notes: output.notes },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ notes: context.notes ?? '' }),
      },
    },
  });

  return { agent, machine };
}

function createWriterAgent() {
  const agent = setupAgent({
    models,
    context: z.object({
      notes: z.string(),
      outline: z.array(z.string()),
      draft: z.string().nullable(),
      review: reviewOutputSchema.nullable(),
      final: z.string().nullable(),
    }),
    input: z.object({ notes: z.string() }),
    output: draftOutputSchema,
    requests: {
      outlineDraft: {
        schemas: {
          input: z.object({ notes: z.string() }),
          output: outlineOutputSchema,
        },
        model: 'writer',
        prompt: ({ input }) => `Create an outline from these notes: ${input.notes}`,
      },
      writeDraft: {
        schemas: {
          input: z.object({
            notes: z.string(),
            outline: z.array(z.string()),
          }),
          output: draftOutputSchema,
        },
        model: 'writer',
        prompt: ({ input }) =>
          `Write from notes: ${input.notes}\nOutline: ${input.outline.join(' | ')}`,
      },
      reviewDraft: {
        schemas: {
          input: z.object({ draft: z.string() }),
          output: reviewOutputSchema,
        },
        model: 'editor',
        prompt: ({ input }) => `Review this draft for clarity: ${input.draft}`,
      },
      reviseDraft: {
        schemas: {
          input: z.object({
            draft: z.string(),
            feedback: z.string(),
          }),
          output: draftOutputSchema,
        },
        model: 'writer',
        prompt: ({ input }) =>
          `Revise draft using feedback.\nDraft: ${input.draft}\nFeedback: ${input.feedback}`,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'writer-agent',
    context: ({ input }) => ({
      notes: input.notes,
      outline: [],
      draft: null,
      review: null,
      final: null,
    }),
    initial: 'outlining',
    states: {
      outlining: {
        invoke: {
          src: 'outlineDraft',
          input: ({ context }) => ({ notes: context.notes }),
          onDone: ({ output }) => ({
            target: 'writing',
            context: { outline: output.outline },
          }),
        },
      },
      writing: {
        invoke: {
          src: 'writeDraft',
          input: ({ context }) => ({
            notes: context.notes,
            outline: context.outline,
          }),
          onDone: ({ output }) => ({
            target: 'reviewing',
            context: { draft: output.draft },
          }),
        },
      },
      reviewing: {
        invoke: {
          src: 'reviewDraft',
          input: ({ context }) => ({ draft: context.draft ?? '' }),
          onDone: ({ output }) => ({
            target: 'routingReview',
            context: { review: output },
          }),
        },
      },
      routingReview: {
      type: 'choice',
      choice: ({ context }) =>
          context.review?.approved
            ? { target: 'done', context: { final: context.draft } }
            : { target: 'revising' },
      },
      revising: {
        invoke: {
          src: 'reviseDraft',
          input: ({ context }) => ({
            draft: context.draft ?? '',
            feedback: context.review?.feedback ?? '',
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { final: output.draft },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.final ?? context.draft ?? '' }),
      },
    },
  });

  return { agent, machine };
}

export function createXStateSubAgentWorkflow() {
  const research = createResearchAgent();
  const writer = createWriterAgent();
  const agent = setupAgent({
    models,
    context: z.object({
      topic: z.string(),
      notes: z.string().nullable(),
      final: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: finalOutputSchema,
    actors: {
      researchAgent: research.machine.provide({
        actorSources: {
          gatherSources: research.agent.requests.gatherSources.withExecutor(
            async ({ input }) => ({
              sources: [
                `${input.topic}: actor supervision notes`,
                `${input.topic}: snapshot handoff notes`,
              ],
            }),
          ),
          summarizeSources: research.agent.requests.summarizeSources.withExecutor(
            async ({ input }) => ({
              notes: `notes:${input.topic}:${input.sources.join('+')}`,
            }),
          ),
        },
      }),
      writerAgent: writer.machine.provide({
        actorSources: {
          outlineDraft: writer.agent.requests.outlineDraft.withExecutor(
            async ({ input }) => ({
              outline: [
                `frame:${input.notes}`,
                'explain delegation',
                'close with review loop',
              ],
            }),
          ),
          writeDraft: writer.agent.requests.writeDraft.withExecutor(
            async ({ input }) => ({
              draft: `draft:${input.outline.join(' > ')}`,
            }),
          ),
          reviewDraft: writer.agent.requests.reviewDraft.withExecutor(
            async ({ input }) => ({
              approved: false,
              feedback: `tighten:${input.draft}`,
            }),
          ),
          reviseDraft: writer.agent.requests.reviseDraft.withExecutor(
            async ({ input }) => ({
              draft: `revised:${input.feedback}`,
            }),
          ),
        },
      }),
    },
  });

  const machine = agent.createMachine({
    id: 'xstate-sub-agents',
    context: ({ input }) => ({ topic: input.topic, notes: null, final: null }),
    initial: 'researching',
    states: {
      researching: {
        invoke: {
          src: 'researchAgent',
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }) => ({
            target: 'writing',
            context: { notes: output.notes },
          }),
        },
      },
      writing: {
        invoke: {
          src: 'writerAgent',
          input: ({ context }) => ({ notes: context.notes ?? '' }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { final: output.draft },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ final: context.final ?? '' }),
      },
    },
  });

  return { machine };
}

export async function runXStateSubAgentsExample() {
  const { machine } = createXStateSubAgentWorkflow();
  const actor = createActor(machine, { input: { topic: 'actor model' } });
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    final: [
      'revised:tighten:draft:frame:notes:actor model:actor model: actor supervision notes+actor model: snapshot handoff notes',
      'explain delegation',
      'close with review loop',
    ].join(' > '),
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runXStateSubAgentsExample();
}
