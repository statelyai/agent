import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { assign, createActor, fromPromise, initialTransition, waitFor } from 'xstate';
import {
  createAgentSchemas,
  createTextLogic,
  getAvailableEvents,
  getAgentEffects,
  getEventTools,
  setupAgent,
  transitionResult,
  type AgentTextInput,
  type TextLogicInput,
  type TextLogicOutput,
} from './index.js';

describe('setupAgent', () => {
  test('withTasks creates typed task actors from schemas', () => {
    const schemas = createAgentSchemas({
      context: z.object({
        prompt: z.string(),
        draft: z.object({ body: z.string() }).nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ body: z.string() }),
      events: {
        READY_TO_DRAFT: z.object({}),
        NEEDS_INFO: z.object({ question: z.string() }),
      },
    });

    const agent = setupAgent({ schemas }).withTasks({
      draftEmail: {
        kind: 'generate',
        schemas: {
          input: z.object({ prompt: z.string() }),
          output: z.object({ body: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.prompt,
        events: ({ input, schemas }) => {
          const prompt: string = input.prompt;
          schemas.events.READY_TO_DRAFT;
          // @ts-expect-error task events input is typed from schemas.input
          input.body;
          return prompt.length > 0 ? ['READY_TO_DRAFT'] : [];
        },
      },
      streamRevision: {
        kind: 'stream',
        schemas: {
          input: z.object({ body: z.string() }),
          output: z.object({ body: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.body,
      },
    });

    expect(agent.tasks.draftEmail.taskKind).toBe('generate');
    expect(agent.tasks.draftEmail.request({ prompt: 'Draft it.' })).toEqual(
      expect.objectContaining({
        model: 'test-model',
        prompt: 'Draft it.',
        allowedEvents: ['READY_TO_DRAFT'],
      })
    );

    setupAgent({ schemas }).withTasks({
      badKind: {
        // @ts-expect-error task kind is constrained
        kind: 'foo',
        schemas: {
          input: z.object({ prompt: z.string() }),
          output: z.object({ body: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.prompt,
      },
    });

    setupAgent({ schemas }).withTasks({
      badEvent: {
        schemas: {
          input: z.object({ prompt: z.string() }),
          output: z.object({ body: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.prompt,
        // @ts-expect-error events are keyed by machine event schemas
        events: ['DRAT_EMAIL_TYPO'],
      },
    });

    setupAgent({ schemas }).withTasks({
      badAllowedEvents: {
        schemas: {
          input: z.object({ prompt: z.string() }),
          output: z.object({ body: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.prompt,
        // @ts-expect-error use task events, not raw text logic allowedEvents
        allowedEvents: ['READY_TO_DRAFT'],
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          // @ts-expect-error task source ids are strongly typed
          invoke: {
            src: 'dratemaltypo',
            input: { prompt: 'Draft it.' },
          },
        },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            src: 'draftEmail',
            // @ts-expect-error task input is schema-typed
            input: { whoopsanything: 42 },
          },
        },
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            id: 'draft',
            src: 'draftEmail',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: {
              target: 'done',
              actions: assign({
                draft: ({ event }) => event.output,
              }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => context.draft ?? { body: '' },
        },
      },
    });

    const [_snapshot, actions] = initialTransition(machine, {
      prompt: 'Draft it.',
    });
    const [effect] = getAgentEffects(actions, {
      actors: agent.tasks,
    });

    expect(effect).toEqual(
      expect.objectContaining({
        kind: 'generate',
        input: expect.objectContaining({ allowedEvents: ['READY_TO_DRAFT'] }),
      })
    );
  });

  test('setupAgent preserves typed action guard and delay names', () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), ready: z.boolean() }),
      input: z.object({ prompt: z.string() }),
      events: {
        MARK_READY: z.object({ reason: z.string() }),
      },
    });

    const agent = setupAgent({
      schemas,
      actions: {
        markReady: assign({
          ready: ({ event }) => {
            if (event.type === 'MARK_READY') {
              const reason: string = event.reason;
              // @ts-expect-error event payload is schema-typed
              event.missing;
              return reason.length > 0;
            }
            return false;
          },
        }),
      },
      guards: {
        hasPrompt: ({ context }) => context.prompt.length > 0,
      },
      delays: {
        shortPause: ({ context }) => {
          // @ts-expect-error delay callback context is schema-typed
          context.missing;
          return context.prompt.length;
        },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, ready: false }),
      initial: 'waiting',
      states: {
        waiting: {
          entry: 'markReady',
          always: { guard: 'hasPrompt', target: 'done' },
          after: { shortPause: 'done' },
          on: {
            MARK_READY: { actions: 'markReady' },
          },
        },
        done: { type: 'final' },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, ready: false }),
      initial: 'waiting',
      states: {
        waiting: {
          // @ts-expect-error action names are setup-typed
          entry: 'markReadtypo',
        },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, ready: false }),
      initial: 'waiting',
      states: {
        waiting: {
          // @ts-expect-error guard names are setup-typed
          always: {
            guard: 'hasPromptypo',
            target: 'done',
          },
        },
        done: { type: 'final' },
      },
    });

  });

  test('authors named text logic with typed input and output', () => {
    const getSummary = createTextLogic({
      schemas: {
        input: z.object({ article: z.string() }),
        output: z.object({ summary: z.string() }),
      },
      model: 'test-model',
      system: 'Summarize articles.',
      prompt: ({ input }) => `Summarize:\n${input.article}`,
      temperature: ({ input }) => input.article.length > 10 ? 0.2 : 0,
    });

    expect(getSummary.request({ article: 'A long article.' })).toEqual(
      expect.objectContaining({
        model: 'test-model',
        system: 'Summarize articles.',
        prompt: 'Summarize:\nA long article.',
        outputSchema: getSummary.schemas.output,
        temperature: 0.2,
      })
    );

    const agent = setupAgent({
      context: z.object({
        article: z.string(),
        summary: z.string().nullable(),
      }),
      input: z.object({ article: z.string() }),
      output: z.object({ summary: z.string() }),
      actors: { getSummary },
    });

    agent.createMachine({
      initial: 'summarizing',
      states: {
        summarizing: {
          // @ts-expect-error setup actors provide strongly typed source names
          invoke: {
            src: 'getSummar',
            input: { article: 'typo' },
          },
        },
      },
    });

    agent.createMachine({
      initial: 'summarizing',
      states: {
        summarizing: {
          // @ts-expect-error named text logic input requires article
          invoke: {
            id: 'getSummary',
            src: 'getSummary',
            input: ({ context }) => ({ prompt: context.article }),
          },
        },
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ article: input.article, summary: null }),
      initial: 'summarizing',
      states: {
        summarizing: {
          invoke: {
            id: 'getSummary',
            src: 'getSummary',
            input: ({ context }) => ({ article: context.article }),
            onDone: {
              target: 'done',
              actions: assign({
                summary: ({ event }) => {
                  const summary: string = event.output.summary;
                  // @ts-expect-error schema-typed output rejects unknown fields
                  event.output.missingField;
                  return summary;
                },
              }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ summary: context.summary ?? '' }),
        },
      },
    });

    let [snapshot, actions] = initialTransition(machine, {
      article: 'State machines make agents inspectable.',
    });
    const [effect] = getAgentEffects(actions, {
      actors: { getSummary },
    });

    expect(effect).toEqual({
      id: 'getSummary',
      src: 'getSummary',
      input: expect.objectContaining({
        model: 'test-model',
        system: 'Summarize articles.',
        prompt: 'Summarize:\nState machines make agents inspectable.',
        outputSchema: getSummary.schemas.output,
      }),
      tools: {},
      events: [],
    });

    [snapshot] = transitionResult(machine, snapshot, effect!, {
      summary: 'Agents become inspectable.',
    });

    expect(snapshot.status).toBe('done');
    expect(snapshot.output).toEqual({ summary: 'Agents become inspectable.' });
  });

  test('named text logic can optionally execute as a promise actor', async () => {
    const answerQuestion = createTextLogic(
      {
        schemas: {
          input: z.object({ question: z.string() }),
          output: z.object({ answer: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.question,
      },
      async ({ input, request, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return {
          answer: `${request.model}:${input.question}`,
        };
      }
    );

    const agent = setupAgent({
      context: z.object({
        question: z.string(),
        answer: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      actors: { answerQuestion },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ question: input.question, answer: null }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            src: 'answerQuestion',
            input: ({ context }) => ({ question: context.question }),
            onDone: {
              target: 'done',
              actions: assign({
                answer: ({ event }) => event.output.answer,
              }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ answer: context.answer ?? '' }),
        },
      },
    });

    const actor = createActor(machine, {
      input: { question: 'can text logic run?' },
    });
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({
      answer: 'test-model:can text logic run?',
    });
  });

  test('named text logic validates executor output', async () => {
    const answerQuestion = createTextLogic(
      {
        schemas: {
          input: z.object({ question: z.string() }),
          output: z.object({ answer: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.question,
      },
      async () => ({ nope: true }) as unknown as { answer: string }
    );

    const agent = setupAgent({
      context: z.object({
        question: z.string(),
        error: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      actors: { answerQuestion },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ question: input.question, error: null }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            src: 'answerQuestion',
            input: ({ context }) => ({ question: context.question }),
            onError: {
              target: 'failed',
              actions: assign({
                error: ({ event }) =>
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          },
        },
        failed: {},
      },
    });

    const actor = createActor(machine, {
      input: { question: 'is output validated?' },
    });
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.matches('failed'));

    expect(actor.getSnapshot().context.error).toContain('expected string');
  });

  test('authors raw XState machines from the root export', async () => {
    const draftSchema = z.object({
      subject: z.string(),
      body: z.string(),
    });
    const draftEmail = createTextLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: draftSchema,
      },
      model: 'test-model',
      prompt: ({ input }) => input.prompt,
      metadata: ({ input }) => ({
        temperature: input.prompt.length > 0 ? 0.2 : 0,
        traceId: `draft:${input.prompt}`,
      }),
    });

    const agent = setupAgent({
      context: z.object({
        prompt: z.string(),
        draft: draftSchema.nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: draftSchema,
      events: {
        RETRY: z.object({ prompt: z.string() }),
      },
      actors: { draftEmail },
    });

    agent.createMachine({
      initial: 'drafting',
      states: {
        drafting: {
          // @ts-expect-error registered source ids are strongly typed string literals
          invoke: {
            id: 'draft',
            src: 'draftEmai',
            input: { prompt: 'misspelled source' },
          },
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-email-drafter',
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            id: 'draft',
            src: 'draftEmail',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: {
              target: 'review',
              actions: assign({
                draft: ({ event }) => {
                  const draft = event.output;
                  const subject: string = draft.subject;
                  // @ts-expect-error schema-typed output rejects unknown fields
                  draft.missingField;
                  return { ...draft, subject };
                },
              }),
            },
          },
        },
        review: {
          on: {
            RETRY: {
              target: 'drafting',
              actions: assign({
                prompt: ({ event }) => event.prompt,
              }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) =>
            context.draft ?? { subject: '', body: '' },
        },
      },
    });

    const calls: AgentTextInput<{ temperature: number; traceId: string }>[] = [];
    const actor = createActor(
      machine.provide({
        actors: {
          draftEmail: fromPromise<
            TextLogicOutput<typeof draftEmail>,
            TextLogicInput<typeof draftEmail>
          >(
            async ({ input }) => {
              const request = draftEmail.request(input);
              calls.push(
                request as AgentTextInput<{
                  temperature: number;
                  traceId: string;
                }>
              );
              return {
                subject: `Re: ${request.prompt}`,
                body: 'Typed raw XState machine body.',
              };
            }
          ),
        },
      }),
      { input: { prompt: 'launch note' } }
    );

    actor.start();

    await waitFor(actor, (snapshot) => snapshot.matches('review'));

    expect(actor.getSnapshot().context.draft).toEqual({
      subject: 'Re: launch note',
      body: 'Typed raw XState machine body.',
    });
    expect(calls).toEqual([
      expect.objectContaining({
        model: 'test-model',
        prompt: 'launch note',
        outputSchema: draftEmail.schemas.output,
        metadata: { temperature: 0.2, traceId: 'draft:launch note' },
      }),
    ]);
  });

  test('extracts agent effects from pure XState transitions', () => {
    const answerSchema = z.object({ answer: z.string() });
    const answerQuestion = createTextLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: answerSchema,
      },
      model: 'test-model',
      prompt: ({ input }) => input.prompt,
      temperature: 0.2,
    });
    const agent = setupAgent({
      context: z.object({
        prompt: z.string(),
        answer: z.string().nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ answer: z.string() }),
      actors: { answerQuestion },
    });

    const machine = agent.createMachine({
      id: 'pure-agent-loop',
      context: ({ input }) => ({ prompt: input.prompt, answer: null }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            id: 'answer',
            src: 'answerQuestion',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: {
              target: 'done',
              actions: assign({
                answer: ({ event }) => event.output.answer,
              }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ answer: context.answer ?? '' }),
        },
      },
    });

    let [snapshot, actions] = initialTransition(machine, {
      prompt: 'why state machines?',
    });
    const [effect] = getAgentEffects(actions, {
      actors: { answerQuestion },
    });

    expect(effect).toEqual({
      id: 'answer',
      src: 'answerQuestion',
      input: expect.objectContaining({
        model: 'test-model',
        prompt: 'why state machines?',
        temperature: 0.2,
        outputSchema: answerQuestion.schemas.output,
      }),
      tools: {},
      events: [],
    });

    [snapshot, actions] = transitionResult(machine, snapshot, effect!, {
      answer: 'Because the workflow matters.',
    });

    expect(getAgentEffects(actions)).toEqual([]);
    expect(snapshot.status).toBe('done');
    expect(snapshot.output).toEqual({
      answer: 'Because the workflow matters.',
    });
  });

  test('agent effects expose only whitelisted allowed state events as tools', async () => {
    const chooseMove = createTextLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: z.string(),
      },
      model: 'test-model',
      prompt: ({ input }) => input.prompt,
      allowedEvents: ['ATTACK', 'DEFEND', 'HEAL'],
    });
    const agent = setupAgent({
      context: z.object({ prompt: z.string() }),
      input: z.object({ prompt: z.string() }),
      events: {
        ATTACK: z.object({ target: z.string() }),
        DEFEND: z.object({}),
        PAUSE: z.object({}),
      },
      actors: { chooseMove },
    });

    const machine = agent.createMachine({
      id: 'game-agent',
      context: ({ input }) => ({ prompt: input.prompt }),
      initial: 'choosing',
      states: {
        choosing: {
          invoke: {
            id: 'chooseMove',
            src: 'chooseMove',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: { target: 'done' },
          },
          on: {
            ATTACK: { target: 'done' },
            DEFEND: { target: 'done' },
            PAUSE: { target: 'paused' },
          },
        },
        paused: {},
        done: { type: 'final' },
      },
    });

    const [snapshot, actions] = initialTransition(machine, {
      prompt: 'Choose the next move.',
    });

    expect(getAvailableEvents(snapshot, {
      schemas: agent.schemas,
      allowedEvents: ['ATTACK', 'DEFEND', 'HEAL'],
    })).toEqual([
      expect.objectContaining({ type: 'ATTACK', toolName: 'event.ATTACK' }),
      expect.objectContaining({ type: 'DEFEND', toolName: 'event.DEFEND' }),
    ]);

    const [effect] = getAgentEffects(actions, {
      snapshot,
      schemas: agent.schemas,
      actors: { chooseMove },
    });

    expect(effect!.events.map((event) => event.type)).toEqual([
      'ATTACK',
      'DEFEND',
    ]);
    expect(Object.keys(effect!.tools)).toEqual([
      'event.ATTACK',
      'event.DEFEND',
    ]);

    const attackTool = effect!.tools['event.ATTACK']!;
    if (typeof attackTool === 'function') {
      throw new Error('Expected event tool descriptor.');
    }
    await expect(attackTool.execute?.({ target: 'orc' })).resolves.toEqual({
      type: 'ATTACK',
      target: 'orc',
    });

    expect(Object.keys(getEventTools(snapshot, {
      schemas: agent.schemas,
      allowedEvents: ['ATTACK', 'DEFEND', 'HEAL'],
    }))).toEqual(['event.ATTACK', 'event.DEFEND']);
  });
});
