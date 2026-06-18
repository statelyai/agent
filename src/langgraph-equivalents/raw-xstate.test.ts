import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { assign, createActor, fromPromise, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../index.js';

describe('LangGraph-style workflows authored as raw XState', () => {
  test('conditional routing uses declarative text actor input', async () => {
    const agent = setupAgent({
      context: z.object({
        request: z.string(),
        route: z.enum(['answer', 'escalate']).nullable(),
      }),
      input: z.object({ request: z.string() }),
      output: z.object({ route: z.enum(['answer', 'escalate']) }),
    }).withTasks({
      routeRequest: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: z.object({ route: z.enum(['answer', 'escalate']) }),
        },
        model: 'classifier',
        prompt: ({ input }) => input.request,
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-branching',
      context: ({ input }) => ({ request: input.request, route: null }),
      initial: 'classifying',
      states: {
        classifying: {
          invoke: {
            src: 'routeRequest',
            input: ({ context }) => ({ request: context.request }),
            onDone: {
              target: 'routing',
              actions: assign({ route: ({ event }) => event.output.route }),
            },
          },
        },
        routing: {
          always: [
            { guard: ({ context }) => context.route === 'escalate', target: 'escalated' },
            { target: 'answered' },
          ],
        },
        answered: { type: 'final', output: () => ({ route: 'answer' as const }) },
        escalated: { type: 'final', output: () => ({ route: 'escalate' as const }) },
      },
    });

    const actor = createActor(
      machine.provide({
        actors: {
          routeRequest: agent.tasks.routeRequest.withExecutor(
            async () => ({ route: 'escalate' })
          ),
        },
      }),
      { input: { request: 'billing is broken' } }
    );

    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({ route: 'escalate' });
  });

  test('human-in-the-loop approval uses typed external events', async () => {
    const agent = setupAgent({
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
    }).withTasks({
      writeDraft: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'writer',
        prompt: ({ input }) => input.topic,
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
            onDone: {
              target: 'reviewing',
              actions: assign({ draft: ({ event }) => event.output }),
            },
          },
        },
        reviewing: {
          on: {
            APPROVE: { target: 'published' },
            REJECT: {
              target: 'drafting',
              actions: assign({
                topic: ({ context, event }) =>
                  `${context.topic}\nRevision: ${event.reason}`,
              }),
            },
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
        actors: {
          writeDraft: agent.tasks.writeDraft.withExecutor(
            async ({ input }) => `Draft: ${input.topic}`
          ),
        },
      }),
      { input: { topic: 'release notes' } }
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

    const agent = setupAgent({
      context: z.object({
        task: z.string(),
        steps: z.array(z.string()),
        results: z.array(z.string()),
      }),
      input: z.object({ task: z.string() }),
      output: z.object({ results: z.array(z.string()) }),
      actors: {
        runStep: fromPromise<string, { step: string }>(
          async ({ input }) => `done:${input.step}`
        ),
      },
    }).withTasks({
      planTask: {
        schemas: {
          input: z.object({ task: z.string() }),
          output: planSchema,
        },
        model: 'planner',
        prompt: ({ input }) => input.task,
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-plan-and-execute',
      context: ({ input }) => ({ task: input.task, steps: [], results: [] }),
      initial: 'planning',
      states: {
        planning: {
          invoke: {
            src: 'planTask',
            input: ({ context }) => ({ task: context.task }),
            onDone: {
              target: 'running',
              actions: assign({ steps: ({ event }) => event.output.steps }),
            },
          },
        },
        running: {
          invoke: {
            src: 'runStep',
            input: ({ context }) => ({ step: context.steps[0] ?? '' }),
            onDone: {
              target: 'checking',
              actions: assign({
                steps: ({ context }) => context.steps.slice(1),
                results: ({ context, event }) => [...context.results, event.output],
              }),
            },
          },
        },
        checking: {
          always: [
            { guard: ({ context }) => context.steps.length > 0, target: 'running' },
            { target: 'done' },
          ],
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ results: context.results }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actors: {
          planTask: agent.tasks.planTask.withExecutor(
            async () => ({ steps: ['research', 'write'] })
          ),
        },
      }),
      { input: { task: 'make a brief' } }
    );

    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({
      results: ['done:research', 'done:write'],
    });
  });

  test('tool-calling streams typed host-side progress', async () => {
    const emitted: string[] = [];
    const agent = setupAgent({
      context: z.object({
        city: z.string(),
        forecast: z.string().nullable(),
      }),
      input: z.object({ city: z.string() }),
      output: z.object({ forecast: z.string() }),
      actors: {
        getWeather: fromPromise<string, { city: string }>(async ({ input }) => {
          emitted.push(`call:${input.city}`);
          emitted.push(`progress:${input.city}:1`);
          emitted.push(`progress:${input.city}:2`);
          return `Sunny in ${input.city}`;
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
            onDone: {
              target: 'done',
              actions: assign({ forecast: ({ event }) => event.output }),
            },
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
    const agent = setupAgent({
      context: z.object({
        topic: z.string(),
        draft: z.string().nullable(),
      }),
      input: z.object({ topic: z.string() }),
      output: z.object({ draft: z.string() }),
      events: {
        APPROVE: z.object({}),
      },
    }).withTasks({
      writeDraft: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'writer',
        prompt: ({ input }) => input.topic,
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
            onDone: {
              target: 'reviewing',
              actions: assign({ draft: ({ event }) => event.output }),
            },
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
      writeDraft: agent.tasks.writeDraft.withExecutor(
        async ({ input }) => `Draft: ${input.topic}`
      ),
    };
    const first = createActor(machine.provide({ actors }), {
      input: { topic: 'incident update' },
    });
    first.start();
    await waitFor(first, (snapshot) => snapshot.matches('reviewing'));

    const persisted = first.getPersistedSnapshot();
    first.stop();

    const restored = createActor(machine.provide({ actors }), {
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
    const childAgent = setupAgent({
      context: z.object({ topic: z.string(), research: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ research: z.string() }),
    }).withTasks({
      researchTopic: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'researcher',
        prompt: ({ input }) => input.topic,
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
            onDone: {
              target: 'done',
              actions: assign({ research: ({ event }) => event.output }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ research: context.research ?? '' }),
        },
      },
    });

    const parentAgent = setupAgent({
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
            onDone: {
              target: 'done',
              actions: assign({
                research: ({ event }) =>
                  (event.output as { research: string }).research,
              }),
            },
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
        actors: {
          child: childMachine.provide({
            actors: {
              researchTopic: childAgent.tasks.researchTopic.withExecutor(
                async ({ input }) => `Research: ${input.topic}`
              ),
            },
          }),
        },
      }),
      { input: { topic: 'agents' } }
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({ research: 'Research: agents' });
  });

  test('supervisor handoff is explicit typed routing', async () => {
    const agent = setupAgent({
      context: z.object({
        request: z.string(),
        route: z.enum(['research', 'write']).nullable(),
        result: z.string().nullable(),
      }),
      input: z.object({ request: z.string() }),
      output: z.object({ result: z.string() }),
      actors: {
        research: fromPromise<string, { request: string }>(
          async ({ input }) => `research:${input.request}`
        ),
        write: fromPromise<string, { request: string }>(
          async ({ input }) => `write:${input.request}`
        ),
      },
    }).withTasks({
      routeRequest: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: z.object({ route: z.enum(['research', 'write']) }),
        },
        model: 'router',
        prompt: ({ input }) => input.request,
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
            onDone: {
              target: 'dispatch',
              actions: assign({ route: ({ event }) => event.output.route }),
            },
          },
        },
        dispatch: {
          always: [
            { guard: ({ context }) => context.route === 'research', target: 'researching' },
            { target: 'writing' },
          ],
        },
        researching: {
          invoke: {
            src: 'research',
            input: ({ context }) => ({ request: context.request }),
            onDone: {
              target: 'done',
              actions: assign({ result: ({ event }) => event.output }),
            },
          },
        },
        writing: {
          invoke: {
            src: 'write',
            input: ({ context }) => ({ request: context.request }),
            onDone: {
              target: 'done',
              actions: assign({ result: ({ event }) => event.output }),
            },
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
        actors: {
          routeRequest: agent.tasks.routeRequest.withExecutor(
            async () => ({ route: 'research' })
          ),
        },
      }),
      { input: { request: 'compare frameworks' } }
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      result: 'research:compare frameworks',
    });
  });

  test('map-reduce fan-out uses typed local actors and normal JavaScript concurrency', async () => {
    const agent = setupAgent({
      context: z.object({
        sections: z.array(z.string()),
        summaries: z.array(z.string()),
        final: z.string().nullable(),
      }),
      input: z.object({ sections: z.array(z.string()) }),
      output: z.object({ final: z.string() }),
      actors: {
        summarizeAll: fromPromise<string[], { sections: string[] }>(
          async ({ input }) =>
            Promise.all(
              input.sections.map(async (section: string) => `summary:${section}`)
            )
        ),
      },
    }).withTasks({
      reduceSummaries: {
        schemas: {
          input: z.object({ summaries: z.array(z.string()) }),
          output: z.string(),
        },
        model: 'reducer',
        prompt: ({ input }) => input.summaries.join('\n'),
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
            onDone: {
              target: 'reducing',
              actions: assign({ summaries: ({ event }) => event.output }),
            },
          },
        },
        reducing: {
          invoke: {
            src: 'reduceSummaries',
            input: ({ context }) => ({ summaries: context.summaries }),
            onDone: {
              target: 'done',
              actions: assign({ final: ({ event }) => event.output }),
            },
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
        actors: {
          reduceSummaries: agent.tasks.reduceSummaries.withExecutor(
            async ({ input }) => `reduced:${input.summaries.join('\n')}`
          ),
        },
      }),
      { input: { sections: ['a', 'b'] } }
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      final: 'reduced:summary:a\nsummary:b',
    });
  });

  test('RAG keeps retrieval as a typed host actor before generation', async () => {
    const agent = setupAgent({
      context: z.object({
        question: z.string(),
        documents: z.array(z.string()),
        answer: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      actors: {
        retrieve: fromPromise<string[], { question: string }>(
          async ({ input }) => [`doc:${input.question}`, 'doc:typed state']
        ),
      },
    }).withTasks({
      answerQuestion: {
        schemas: {
          input: z.object({
            question: z.string(),
            documents: z.array(z.string()),
          }),
          output: z.string(),
        },
        model: 'answerer',
        prompt: ({ input }) => `Q: ${input.question}\nDocs:\n${input.documents.join('\n')}`,
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
            onDone: {
              target: 'answering',
              actions: assign({ documents: ({ event }) => event.output }),
            },
          },
        },
        answering: {
          invoke: {
            src: 'answerQuestion',
            input: ({ context }) => ({
              question: context.question,
              documents: context.documents,
            }),
            onDone: {
              target: 'done',
              actions: assign({ answer: ({ event }) => event.output }),
            },
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
        actors: {
          answerQuestion: agent.tasks.answerQuestion.withExecutor(
            async ({ input }) =>
              `answer from Q: ${input.question}\nDocs:\n${input.documents.join('\n')}`
          ),
        },
      }),
      { input: { question: 'why xstate agents?' } }
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual(
      expect.objectContaining({
        answer: expect.stringContaining('doc:typed state'),
      })
    );
  });

  test('reflection loops are explicit guarded states with validated critique output', async () => {
    const critiqueSchema = z.object({
      approved: z.boolean(),
      feedback: z.string(),
    });
    let critiqueCount = 0;
    const agent = setupAgent({
      context: z.object({
        prompt: z.string(),
        draft: z.string().nullable(),
        feedback: z.string().nullable(),
        approved: z.boolean(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ draft: z.string() }),
    }).withTasks({
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
            onDone: {
              target: 'critiquing',
              actions: assign({ draft: ({ event }) => event.output }),
            },
          },
        },
        critiquing: {
          invoke: {
            src: 'critiqueDraft',
            input: ({ context }) => ({ draft: context.draft ?? '' }),
            onDone: {
              target: 'checking',
              actions: assign({
                approved: ({ event }) => event.output.approved,
                feedback: ({ event }) => event.output.feedback,
              }),
            },
          },
        },
        checking: {
          always: [
            { guard: ({ context }) => context.approved, target: 'done' },
            { target: 'drafting' },
          ],
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ draft: context.draft ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actors: {
          writeDraft: agent.tasks.writeDraft.withExecutor(
            async ({ input }) => `draft:${
              input.feedback
                ? `${input.prompt}\nRevise: ${input.feedback}`
                : input.prompt
            }`
          ),
          critiqueDraft: agent.tasks.critiqueDraft.withExecutor(
            async () => {
              critiqueCount += 1;
              return {
                approved: critiqueCount > 1,
                feedback: critiqueCount > 1 ? 'ship' : 'add evidence',
              };
            }
          ),
        },
      }),
      { input: { prompt: 'make the case' } }
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
          task: z.string(),
        })
      ),
    });
    const agent = setupAgent({
      context: z.object({
        goal: z.string(),
        steps: z.array(z.object({ id: z.string(), task: z.string() })),
        evidence: z.record(z.string(), z.string()),
        answer: z.string().nullable(),
      }),
      input: z.object({ goal: z.string() }),
      output: z.object({
        answer: z.string(),
        evidence: z.record(z.string(), z.string()),
      }),
      actors: {
        executePlan: fromPromise<
          Record<string, string>,
          { steps: Array<{ id: string; task: string }> }
        >(async ({ input }) =>
          Object.fromEntries(
            input.steps.map((step: { id: string; task: string }) => [
              step.id,
              `result:${step.task}`,
            ])
          )
        ),
      },
    }).withTasks({
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
            onDone: {
              target: 'working',
              actions: assign({ steps: ({ event }) => event.output.steps }),
            },
          },
        },
        working: {
          invoke: {
            src: 'executePlan',
            input: ({ context }) => ({ steps: context.steps }),
            onDone: {
              target: 'solving',
              actions: assign({ evidence: ({ event }) => event.output }),
            },
          },
        },
        solving: {
          invoke: {
            src: 'solveWork',
            input: ({ context }) => ({ evidence: context.evidence }),
            onDone: {
              target: 'done',
              actions: assign({ answer: ({ event }) => event.output }),
            },
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
        actors: {
          planWork: agent.tasks.planWork.withExecutor(
            async ({ input }) => ({ steps: [{ id: 'E1', task: input.goal }] })
          ),
          solveWork: agent.tasks.solveWork.withExecutor(
            async ({ input }) => `answer:${JSON.stringify(input.evidence)}`
          ),
        },
      }),
      { input: { goal: 'compare tools' } }
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
    const agent = setupAgent({
      context: z.object({
        question: z.string(),
        sql: z.string().nullable(),
        rows: z.array(z.record(z.string(), z.string())),
        answer: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      output: z.object({ sql: z.string(), answer: z.string() }),
      actors: {
        queryDatabase: fromPromise<
          Array<Record<string, string>>,
          { sql: string }
        >(async ({ input }) => [{ total: '42', sql: input.sql }]),
      },
    }).withTasks({
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
          input: z.object({ rows: z.array(z.record(z.string(), z.string())) }),
          output: z.string(),
        },
        model: 'answerer',
        prompt: ({ input }) => JSON.stringify(input.rows),
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
            onDone: {
              target: 'querying',
              actions: assign({ sql: ({ event }) => event.output.sql }),
            },
          },
        },
        querying: {
          invoke: {
            src: 'queryDatabase',
            input: ({ context }) => ({ sql: context.sql ?? '' }),
            onDone: {
              target: 'answering',
              actions: assign({ rows: ({ event }) => event.output }),
            },
          },
        },
        answering: {
          invoke: {
            src: 'answerRows',
            input: ({ context }) => ({ rows: context.rows }),
            onDone: {
              target: 'done',
              actions: assign({ answer: ({ event }) => event.output }),
            },
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
        actors: {
          writeQuery: agent.tasks.writeQuery.withExecutor(
            async () => ({ sql: 'select count(*) as total from users' })
          ),
          answerRows: agent.tasks.answerRows.withExecutor(
            async ({ input }) => `final:${JSON.stringify(input.rows)}`
          ),
        },
      }),
      { input: { question: 'how many users?' } }
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      sql: 'select count(*) as total from users',
      answer: 'final:[{"total":"42","sql":"select count(*) as total from users"}]',
    });
  });

  test('persistent multi-agent networks resume with plain XState snapshots', async () => {
    const agent = setupAgent({
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
        research: fromPromise<string, { topic: string }>(
          async ({ input }) => `research:${input.topic}`
        ),
        write: fromPromise<string, { research: string }>(
          async ({ input }) => `draft:${input.research}`
        ),
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
            onDone: {
              target: 'waitingToWrite',
              actions: assign({ research: ({ event }) => event.output }),
            },
          },
        },
        waitingToWrite: {
          on: { CONTINUE: { target: 'writing' } },
        },
        writing: {
          invoke: {
            src: 'write',
            input: ({ context }) => ({ research: context.research ?? '' }),
            onDone: {
              target: 'done',
              actions: assign({ draft: ({ event }) => event.output }),
            },
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
    const agent = setupAgent({
      context: z.object({ topic: z.string(), text: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ text: z.string() }),
    }).withTasks({
      streamTopic: {
        kind: 'stream',
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'writer',
        prompt: ({ input }) => input.topic,
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
            onDone: {
              target: 'done',
              actions: assign({ text: ({ event }) => event.output }),
            },
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
        actors: {
          streamTopic: agent.tasks.streamTopic.withExecutor(
            async ({ input }) => {
              chunks.push('hello');
              chunks.push(input.topic);
              return chunks.join(' ');
            }
          ),
        },
      }),
      { input: { topic: 'agents' } }
    );
    actor.start();
    await toPromise(actor);

    expect(chunks).toEqual(['hello', 'agents']);
    expect(actor.getSnapshot().output).toEqual({ text: 'hello agents' });
  });
});
