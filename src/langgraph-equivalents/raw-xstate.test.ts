import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { createExampleSetup } from '../example-setup.test-utils.js';

describe('LangGraph-style workflows authored as raw XState', () => {
  test('conditional routing uses declarative text actor input', async () => {
    const agent = createExampleSetup({
      context: z.object({
        request: z.string(),
        route: z.enum(['answer', 'escalate']).nullable(),
      }),
      input: z.object({ request: z.string() }),
      output: z.object({ route: z.enum(['answer', 'escalate']) }),
      requests: {
        routeRequest: {
          schemas: {
            input: z.object({ request: z.string() }),
            output: z.object({ route: z.enum(['answer', 'escalate']) }),
          },
          model: 'classifier',
          prompt: ({ input }) => input.request,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-branching',
      context: ({ input }) => ({ request: input.request, route: null }),
      output: ({ context }) => ({ route: context.route ?? 'answer' }),
      initial: 'classifying',
      states: {
        classifying: {
          invoke: {
            src: 'routeRequest',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'routing',
              context: { route: output.route },
            }),
          },
        },
        routing: {
          always: ({ context }) =>
            context.route === 'escalate'
              ? { target: 'escalated' }
              : { target: 'answered' },
        },
        answered: {
          type: 'final',
          output: () => ({ route: 'answer' as const }),
        },
        escalated: {
          type: 'final',
          output: () => ({ route: 'escalate' as const }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          routeRequest: agent.requests.routeRequest.withExecutor(async () => ({
            route: 'escalate',
          })),
        },
      }),
      { input: { request: 'billing is broken' } },
    );

    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({ route: 'escalate' });
  });

  test('human-in-the-loop approval uses typed external events', async () => {
    const agent = createExampleSetup({
      context: z.object({
        topic: z.string(),
        draft: z.string().nullable(),
      }),
      input: z.object({ topic: z.string() }),
      output: z.object({ published: z.boolean(), draft: z.string() }),
      events: {
        APPROVE: z.object({}),
        REJECT: z.object({ reason: z.string() }),
      },
      requests: {
        writeDraft: {
          schemas: {
            input: z.object({ topic: z.string() }),
            output: z.string(),
          },
          model: 'writer',
          prompt: ({ input }) => input.topic,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-hitl',
      context: ({ input }) => ({ topic: input.topic, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            src: 'writeDraft',
            input: ({ context }: { context: { topic: string } }) => ({
              topic: context.topic,
            }),
            onDone: ({ output }) => ({
              target: 'reviewing',
              context: { draft: output },
            }),
          },
        },
        reviewing: {
          on: {
            APPROVE: { target: 'published' },
            REJECT: ({ context, event }) => ({
              target: 'drafting',
              context: {
                topic: `${context.topic}\nRevision: ${(event as unknown as { reason: string }).reason}`,
              },
            }),
          },
        },
        published: {
          type: 'final',
          output: ({ context }) => ({
            published: true,
            draft: context.draft ?? '',
          }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          writeDraft: agent.requests.writeDraft.withExecutor(
            async ({ input }) => `Draft: ${input.topic}`,
          ),
        },
      }),
      { input: { topic: 'release notes' } },
    );

    actor.start();
    await waitFor(actor, (snapshot) => snapshot.matches('reviewing'));
    actor.send({ type: 'APPROVE' });
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({
      published: true,
      draft: 'Draft: release notes',
    });
  });

  test('plan-and-execute composes generated output and local actors', async () => {
    const planSchema = z.object({
      steps: z.array(z.string()),
    });
    const agent = createExampleSetup({
      context: z.object({
        request: z.string(),
        steps: z.array(z.string()),
        results: z.array(z.string()),
      }),
      input: z.object({ request: z.string() }),
      output: z.object({ results: z.array(z.string()) }),
      actors: {
        runStep: createAsyncLogic<string, { step: string }>({
          run: async ({ input }) => `done:${input.step}`,
        }),
      },
      requests: {
        planTask: {
          schemas: {
            input: z.object({ request: z.string() }),
            output: planSchema,
          },
          model: 'planner',
          prompt: ({ input }) => input.request,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-plan-and-execute',
      context: ({ input }) => ({
        request: input.request,
        steps: [],
        results: [],
      }),
      initial: 'planning',
      states: {
        planning: {
          invoke: {
            src: 'planTask',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'running',
              context: { steps: output.steps },
            }),
          },
        },
        running: {
          invoke: {
            src: 'runStep',
            input: ({ context }) => ({ step: context.steps[0] ?? '' }),
            onDone: ({ context, output }) => ({
              target: 'checking',
              context: {
                steps: context.steps.slice(1),
                results: [...context.results, output],
              },
            }),
          },
        },
        checking: {
          always: ({ context }) =>
            context.steps.length > 0 ? { target: 'running' } : { target: 'done' },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ results: context.results }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          planTask: agent.requests.planTask.withExecutor(async () => ({
            steps: ['research', 'write'],
          })),
        },
      }),
      { input: { request: 'make a brief' } },
    );

    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({
      results: ['done:research', 'done:write'],
    });
  });

  test('tool-calling streams typed host-side progress', async () => {
    const emitted: string[] = [];
    const agent = createExampleSetup({
      context: z.object({
        city: z.string(),
        forecast: z.string().nullable(),
      }),
      input: z.object({ city: z.string() }),
      output: z.object({ forecast: z.string() }),
      actors: {
        getWeather: createAsyncLogic<string, { city: string }>({
          run: async ({ input }) => {
            emitted.push(`call:${input.city}`);
            emitted.push(`progress:${input.city}:1`);
            emitted.push(`progress:${input.city}:2`);
            return `Sunny in ${input.city}`;
          },
        }),
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-tool-calling',
      context: ({ input }) => ({ city: input.city, forecast: null }),
      initial: 'checkingWeather',
      states: {
        checkingWeather: {
          invoke: {
            src: 'getWeather',
            input: ({ context }) => ({ city: context.city }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { forecast: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ forecast: context.forecast ?? '' }),
        },
      },
    });

    const actor = createActor(machine, { input: { city: 'Boston' } });
    actor.start();
    await toPromise(actor);

    expect(emitted).toEqual([
      'call:Boston',
      'progress:Boston:1',
      'progress:Boston:2',
    ]);
    expect(actor.getSnapshot().output).toEqual({ forecast: 'Sunny in Boston' });
  });

  test('persistence restores from XState snapshots without a custom runtime', async () => {
    const agent = createExampleSetup({
      context: z.object({
        topic: z.string(),
        draft: z.string().nullable(),
      }),
      input: z.object({ topic: z.string() }),
      output: z.object({ draft: z.string() }),
      events: {
        APPROVE: z.object({}),
      },
      requests: {
        writeDraft: {
          schemas: {
            input: z.object({ topic: z.string() }),
            output: z.string(),
          },
          model: 'writer',
          prompt: ({ input }) => input.topic,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-persistence',
      context: ({ input }) => ({ topic: input.topic, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            src: 'writeDraft',
            input: ({ context }: { context: { topic: string } }) => ({
              topic: context.topic,
            }),
            onDone: ({ output }) => ({
              target: 'reviewing',
              context: { draft: output },
            }),
          },
        },
        reviewing: {
          on: { APPROVE: { target: 'done' } },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ draft: context.draft ?? '' }),
        },
      },
    });

    const actors = {
      writeDraft: agent.requests.writeDraft.withExecutor(
        async ({ input }) => `Draft: ${input.topic}`,
      ),
    };
    const first = createActor(machine.provide({ actorSources: actors }), {
      input: { topic: 'incident update' },
    });
    first.start();
    await waitFor(first, (snapshot) => snapshot.matches('reviewing'));

    const persisted = first.getPersistedSnapshot();
    first.stop();

    const restored = createActor(machine.provide({ actorSources: actors }), {
      input: { topic: 'incident update' },
      snapshot: persisted,
    });
    restored.start();
    restored.send({ type: 'APPROVE' });
    await toPromise(restored);

    expect(restored.getSnapshot().output).toEqual({
      draft: 'Draft: incident update',
    });
  });

  test('subflows compose as typed child actors', async () => {
    const childAgent = createExampleSetup({
      context: z.object({ topic: z.string(), research: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ research: z.string() }),
      requests: {
        researchTopic: {
          schemas: {
            input: z.object({ topic: z.string() }),
            output: z.string(),
          },
          model: 'researcher',
          prompt: ({ input }) => input.topic,
        },
      },
    });
    const childMachine = childAgent.createMachine({
      id: 'raw-xstate-child-research',
      context: ({ input }) => ({ topic: input.topic, research: null }),
      initial: 'researching',
      states: {
        researching: {
          invoke: {
            src: 'researchTopic',
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { research: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ research: context.research ?? '' }),
        },
      },
    });

    const parentAgent = createExampleSetup({
      context: z.object({ topic: z.string(), research: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ research: z.string() }),
      actors: { child: childMachine },
    });
    const parentMachine = parentAgent.createMachine({
      id: 'raw-xstate-parent-subflow',
      context: ({ input }) => ({ topic: input.topic, research: null }),
      initial: 'delegating',
      states: {
        delegating: {
          invoke: {
            src: 'child',
            input: ({ context }: { context: { topic: string } }) => ({
              topic: context.topic,
            }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { research: (output as { research: string }).research },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ research: context.research ?? '' }),
        },
      },
    });

    const actor = createActor(
      parentMachine.provide({
        actorSources: {
          child: childMachine.provide({
            actorSources: {
              researchTopic: childAgent.requests.researchTopic.withExecutor(
                async ({ input }) => `Research: ${input.topic}`,
              ),
            },
          }),
        },
      }),
      { input: { topic: 'agents' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      research: 'Research: agents',
    });
  });

  test('supervisor handoff is explicit typed routing', async () => {
    const agent = createExampleSetup({
      context: z.object({
        request: z.string(),
        route: z.enum(['research', 'write']).nullable(),
        result: z.string().nullable(),
      }),
      input: z.object({ request: z.string() }),
      output: z.object({ result: z.string() }),
      actors: {
        research: createAsyncLogic<string, { request: string }>({
          run: async ({ input }) => `research:${input.request}`,
        }),
        write: createAsyncLogic<string, { request: string }>({
          run: async ({ input }) => `write:${input.request}`,
        }),
      },
      requests: {
        routeRequest: {
          schemas: {
            input: z.object({ request: z.string() }),
            output: z.object({ route: z.enum(['research', 'write']) }),
          },
          model: 'router',
          prompt: ({ input }) => input.request,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-supervisor',
      context: ({ input }) => ({
        request: input.request,
        route: null,
        result: null,
      }),
      initial: 'routing',
      states: {
        routing: {
          invoke: {
            src: 'routeRequest',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'dispatch',
              context: { route: output.route },
            }),
          },
        },
        dispatch: {
          always: ({ context }) =>
            context.route === 'research'
              ? { target: 'researching' }
              : { target: 'writing' },
        },
        researching: {
          invoke: {
            src: 'research',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { result: output },
            }),
          },
        },
        writing: {
          invoke: {
            src: 'write',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { result: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ result: context.result ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          routeRequest: agent.requests.routeRequest.withExecutor(async () => ({
            route: 'research',
          })),
        },
      }),
      { input: { request: 'compare frameworks' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      result: 'research:compare frameworks',
    });
  });

  test('map-reduce fan-out uses typed local actors and normal JavaScript concurrency', async () => {
    const agent = createExampleSetup({
      context: z.object({
        sections: z.array(z.string()),
        summaries: z.array(z.string()),
        final: z.string().nullable(),
      }),
      input: z.object({ sections: z.array(z.string()) }),
      output: z.object({ final: z.string() }),
      actors: {
        summarizeAll: createAsyncLogic<string[], { sections: string[] }>({
          run: async ({ input }) =>
            Promise.all(
              input.sections.map(
                async (section: string) => `summary:${section}`,
              ),
            ),
        }),
      },
      requests: {
        reduceSummaries: {
          schemas: {
            input: z.object({ summaries: z.array(z.string()) }),
            output: z.string(),
          },
          model: 'reducer',
          prompt: ({ input }) => input.summaries.join('\n'),
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-map-reduce',
      context: ({ input }) => ({
        sections: input.sections,
        summaries: [],
        final: null,
      }),
      initial: 'mapping',
      states: {
        mapping: {
          invoke: {
            src: 'summarizeAll',
            input: ({ context }) => ({ sections: context.sections }),
            onDone: ({ output }) => ({
              target: 'reducing',
              context: { summaries: output },
            }),
          },
        },
        reducing: {
          invoke: {
            src: 'reduceSummaries',
            input: ({ context }) => ({ summaries: context.summaries }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { final: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ final: context.final ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          reduceSummaries: agent.requests.reduceSummaries.withExecutor(
            async ({ input }) => `reduced:${input.summaries.join('\n')}`,
          ),
        },
      }),
      { input: { sections: ['a', 'b'] } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      final: 'reduced:summary:a\nsummary:b',
    });
  });

  test('RAG keeps retrieval as a typed host actor before generation', async () => {
    const agent = createExampleSetup({
      context: z.object({
        question: z.string(),
        documents: z.array(z.string()),
        answer: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      actors: {
        retrieve: createAsyncLogic<string[], { question: string }>({
          run: async ({ input }) => [`doc:${input.question}`, 'doc:typed state'],
        }),
      },
      requests: {
        answerQuestion: {
          schemas: {
            input: z.object({
              question: z.string(),
              documents: z.array(z.string()),
            }),
            output: z.string(),
          },
          model: 'answerer',
          prompt: ({ input }) =>
            `Q: ${input.question}\nDocs:\n${input.documents.join('\n')}`,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-rag',
      context: ({ input }) => ({
        question: input.question,
        documents: [],
        answer: null,
      }),
      initial: 'retrieving',
      states: {
        retrieving: {
          invoke: {
            src: 'retrieve',
            input: ({ context }) => ({ question: context.question }),
            onDone: ({ output }) => ({
              target: 'answering',
              context: { documents: output },
            }),
          },
        },
        answering: {
          invoke: {
            src: 'answerQuestion',
            input: ({ context }) => ({
              question: context.question,
              documents: context.documents,
            }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { answer: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ answer: context.answer ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          answerQuestion: agent.requests.answerQuestion.withExecutor(
            async ({ input }) =>
              `answer from Q: ${input.question}\nDocs:\n${input.documents.join('\n')}`,
          ),
        },
      }),
      { input: { question: 'why xstate agents?' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual(
      expect.objectContaining({
        answer: expect.stringContaining('doc:typed state'),
      }),
    );
  });

  test('reflection loops are explicit guarded states with validated critique output', async () => {
    const critiqueSchema = z.object({
      approved: z.boolean(),
      feedback: z.string(),
    });
    let critiqueCount = 0;
    const agent = createExampleSetup({
      context: z.object({
        prompt: z.string(),
        draft: z.string().nullable(),
        feedback: z.string().nullable(),
        approved: z.boolean(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ draft: z.string() }),
      requests: {
        writeDraft: {
          schemas: {
            input: z.object({
              prompt: z.string(),
              feedback: z.string().nullable(),
            }),
            output: z.string(),
          },
          model: 'writer',
          prompt: ({ input }) =>
            input.feedback
              ? `${input.prompt}\nRevise: ${input.feedback}`
              : input.prompt,
        },
        critiqueDraft: {
          schemas: {
            input: z.object({ draft: z.string() }),
            output: critiqueSchema,
          },
          model: 'critic',
          prompt: ({ input }) => input.draft,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-reflection',
      context: ({ input }) => ({
        prompt: input.prompt,
        draft: null,
        feedback: null,
        approved: false,
      }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            src: 'writeDraft',
            input: ({ context }) => ({
              prompt: context.prompt,
              feedback: context.feedback,
            }),
            onDone: ({ output }) => ({
              target: 'critiquing',
              context: { draft: output },
            }),
          },
        },
        critiquing: {
          invoke: {
            src: 'critiqueDraft',
            input: ({ context }) => ({ draft: context.draft ?? '' }),
            onDone: ({ output }) => ({
              target: 'checking',
              context: {
                approved: output.approved,
                feedback: output.feedback,
              },
            }),
          },
        },
        checking: {
          always: ({ context }) =>
            context.approved ? { target: 'done' } : { target: 'drafting' },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ draft: context.draft ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          writeDraft: agent.requests.writeDraft.withExecutor(
            async ({ input }) =>
              `draft:${
                input.feedback
                  ? `${input.prompt}\nRevise: ${input.feedback}`
                  : input.prompt
              }`,
          ),
          critiqueDraft: agent.requests.critiqueDraft.withExecutor(async () => {
            critiqueCount += 1;
            return {
              approved: critiqueCount > 1,
              feedback: critiqueCount > 1 ? 'ship' : 'add evidence',
            };
          }),
        },
      }),
      { input: { prompt: 'make the case' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      draft: 'draft:make the case\nRevise: add evidence',
    });
  });

  test('ReWOO-style planner and worker decomposition stays explicit', async () => {
    const planSchema = z.object({
      steps: z.array(
        z.object({
          id: z.string(),
          request: z.string(),
        }),
      ),
    });
    const agent = createExampleSetup({
      context: z.object({
        goal: z.string(),
        steps: z.array(z.object({ id: z.string(), request: z.string() })),
        evidence: z.record(z.string(), z.string()),
        answer: z.string().nullable(),
      }),
      input: z.object({ goal: z.string() }),
      output: z.object({
        answer: z.string(),
        evidence: z.record(z.string(), z.string()),
      }),
      actors: {
        executePlan: createAsyncLogic<
          Record<string, string>,
          { steps: Array<{ id: string; request: string }> }
        >({
          run: async ({ input }) =>
            Object.fromEntries(
              input.steps.map((step: { id: string; request: string }) => [
                step.id,
                `result:${step.request}`,
              ]),
            ),
        }),
      },
      requests: {
        planWork: {
          schemas: {
            input: z.object({ goal: z.string() }),
            output: planSchema,
          },
          model: 'planner',
          prompt: ({ input }) => input.goal,
        },
        solveWork: {
          schemas: {
            input: z.object({ evidence: z.record(z.string(), z.string()) }),
            output: z.string(),
          },
          model: 'solver',
          prompt: ({ input }) => JSON.stringify(input.evidence),
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-rewoo',
      context: ({ input }) => ({
        goal: input.goal,
        steps: [],
        evidence: {},
        answer: null,
      }),
      initial: 'planning',
      states: {
        planning: {
          invoke: {
            src: 'planWork',
            input: ({ context }) => ({ goal: context.goal }),
            onDone: ({ output }) => ({
              target: 'working',
              context: { steps: output.steps },
            }),
          },
        },
        working: {
          invoke: {
            src: 'executePlan',
            input: ({ context }) => ({ steps: context.steps }),
            onDone: ({ output }) => ({
              target: 'solving',
              context: { evidence: output },
            }),
          },
        },
        solving: {
          invoke: {
            src: 'solveWork',
            input: ({ context }) => ({ evidence: context.evidence }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { answer: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({
            answer: context.answer ?? '',
            evidence: context.evidence,
          }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          planWork: agent.requests.planWork.withExecutor(async ({ input }) => ({
            steps: [{ id: 'E1', request: input.goal }],
          })),
          solveWork: agent.requests.solveWork.withExecutor(
            async ({ input }) => `answer:${JSON.stringify(input.evidence)}`,
          ),
        },
      }),
      { input: { goal: 'compare tools' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      answer: 'answer:{"E1":"result:compare tools"}',
      evidence: { E1: 'result:compare tools' },
    });
  });

  test('SQL-style agents keep query generation, execution, and answer synthesis explicit', async () => {
    const querySchema = z.object({ sql: z.string() });
    const agent = createExampleSetup({
      context: z.object({
        question: z.string(),
        sql: z.string().nullable(),
        rows: z.array(z.record(z.string(), z.string())),
        answer: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      output: z.object({ sql: z.string(), answer: z.string() }),
      actors: {
        queryDatabase: createAsyncLogic<
          Array<Record<string, string>>,
          { sql: string }
        >({
          run: async ({ input }) => [{ total: '42', sql: input.sql }],
        }),
      },
      requests: {
        writeQuery: {
          schemas: {
            input: z.object({ question: z.string() }),
            output: querySchema,
          },
          model: 'sql-writer',
          prompt: ({ input }) => input.question,
        },
        answerRows: {
          schemas: {
            input: z.object({
              rows: z.array(z.record(z.string(), z.string())),
            }),
            output: z.string(),
          },
          model: 'answerer',
          prompt: ({ input }) => JSON.stringify(input.rows),
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-sql-agent',
      context: ({ input }) => ({
        question: input.question,
        sql: null,
        rows: [],
        answer: null,
      }),
      initial: 'writingQuery',
      states: {
        writingQuery: {
          invoke: {
            src: 'writeQuery',
            input: ({ context }) => ({ question: context.question }),
            onDone: ({ output }) => ({
              target: 'querying',
              context: { sql: output.sql },
            }),
          },
        },
        querying: {
          invoke: {
            src: 'queryDatabase',
            input: ({ context }) => ({ sql: context.sql ?? '' }),
            onDone: ({ output }) => ({
              target: 'answering',
              context: { rows: output },
            }),
          },
        },
        answering: {
          invoke: {
            src: 'answerRows',
            input: ({ context }) => ({ rows: context.rows }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { answer: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({
            sql: context.sql ?? '',
            answer: context.answer ?? '',
          }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          writeQuery: agent.requests.writeQuery.withExecutor(async () => ({
            sql: 'select count(*) as total from users',
          })),
          answerRows: agent.requests.answerRows.withExecutor(
            async ({ input }) => `final:${JSON.stringify(input.rows)}`,
          ),
        },
      }),
      { input: { question: 'how many users?' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      sql: 'select count(*) as total from users',
      answer:
        'final:[{"total":"42","sql":"select count(*) as total from users"}]',
    });
  });

  test('persistent multi-agent networks resume with plain XState snapshots', async () => {
    const agent = createExampleSetup({
      context: z.object({
        topic: z.string(),
        research: z.string().nullable(),
        draft: z.string().nullable(),
      }),
      input: z.object({ topic: z.string() }),
      output: z.object({ draft: z.string() }),
      events: {
        CONTINUE: z.object({}),
      },
      actors: {
        research: createAsyncLogic<string, { topic: string }>({
          run: async ({ input }) => `research:${input.topic}`,
        }),
        write: createAsyncLogic<string, { research: string }>({
          run: async ({ input }) => `draft:${input.research}`,
        }),
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-persistent-network',
      context: ({ input }) => ({
        topic: input.topic,
        research: null,
        draft: null,
      }),
      initial: 'researching',
      states: {
        researching: {
          invoke: {
            src: 'research',
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: 'waitingToWrite',
              context: { research: output },
            }),
          },
        },
        waitingToWrite: {
          on: { CONTINUE: { target: 'writing' } },
        },
        writing: {
          invoke: {
            src: 'write',
            input: ({ context }) => ({ research: context.research ?? '' }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { draft: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ draft: context.draft ?? '' }),
        },
      },
    });

    const first = createActor(machine, { input: { topic: 'xstate' } });
    first.start();
    await waitFor(first, (snapshot) => snapshot.matches('waitingToWrite'));
    const persisted = first.getPersistedSnapshot();
    first.stop();

    const restored = createActor(machine, {
      input: { topic: 'xstate' },
      snapshot: persisted,
    });
    restored.start();
    restored.send({ type: 'CONTINUE' });
    await toPromise(restored);

    expect(restored.getSnapshot().output).toEqual({
      draft: 'draft:research:xstate',
    });
  });

  test('streaming keeps chunks in the host side channel', async () => {
    const chunks: string[] = [];
    const agent = createExampleSetup({
      context: z.object({ topic: z.string(), text: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ text: z.string() }),
      requests: {
        streamTopic: {
          mode: 'stream',
          schemas: {
            input: z.object({ topic: z.string() }),
            output: z.string(),
          },
          model: 'writer',
          prompt: ({ input }) => input.topic,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-streaming',
      context: ({ input }) => ({ topic: input.topic, text: null }),
      initial: 'streaming',
      states: {
        streaming: {
          invoke: {
            src: 'streamTopic',
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { text: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ text: context.text ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          streamTopic: agent.requests.streamTopic.withExecutor(
            async ({ input }) => {
              chunks.push('hello');
              chunks.push(input.topic);
              return chunks.join(' ');
            },
          ),
        },
      }),
      { input: { topic: 'agents' } },
    );
    actor.start();
    await toPromise(actor);

    expect(chunks).toEqual(['hello', 'agents']);
    expect(actor.getSnapshot().output).toEqual({ text: 'hello agents' });
  });
});
