import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createActor, createAsyncLogic, setup, toPromise } from 'xstate';
import {
  createAgentSchemas,
  createDecisionLogic,
  createTextLogic,
  runAgent,
  sendDecision,
  setupAgent,
  type AgentDecisionRequest,
  type AgentTextRequest,
  type AgentTools,
  type ChosenEvent,
} from './index.js';

describe('runAgent', () => {
  test('done path: completes with typed output from a TextLogic invoke', async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ answer: z.string() }),
    });

    const answerQuestion = createTextLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: z.object({ answer: z.string() }),
      },
      model: 'test-model',
      prompt: ({ input }) => input.prompt,
    });

    const agent = setupAgent({ schemas, actorSources: { answerQuestion } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, answer: null }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            id: 'answer',
            src: 'answerQuestion',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { answer: output.answer },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ answer: context.answer ?? '' }),
        },
      },
    });

    const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => ({
      output: { answer: `Answered: ${request.prompt}` },
    });

    const result = await runAgent(machine, {
      input: { prompt: 'why state machines?' },
      generateText,
    });

    expect(result.status).toBe('done');
    expect(result.status === 'done' ? result.output : undefined).toEqual({
      answer: 'Answered: why state machines?',
    });
  });

  test('idle + resume: settles idle waiting for an event, then completes on resume', async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), draft: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ draft: z.string() }),
      events: { APPROVE: z.object({}) },
    });

    const draftText = createTextLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: z.string(),
      },
      model: 'test-model',
      prompt: ({ input }) => input.prompt,
    });

    const agent = setupAgent({ schemas, actorSources: { draftText } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            id: 'draft',
            src: 'draftText',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: 'awaitingApproval',
              context: { draft: output },
            }),
          },
        },
        awaitingApproval: {
          on: { APPROVE: { target: 'done' } },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ draft: context.draft ?? '' }),
        },
      },
    });

    const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => ({
      output: `Draft: ${request.prompt}`,
    });

    const first = await runAgent(machine, {
      input: { prompt: 'release notes' },
      generateText,
    });

    expect(first.status).toBe('idle');
    if (first.status !== 'idle') {
      throw new Error('expected idle');
    }
    expect(first.snapshot.value).toBe('awaitingApproval');

    const second = await runAgent(machine, {
      snapshot: first.snapshot,
      event: { type: 'APPROVE' },
      generateText,
    });

    expect(second.status).toBe('done');
    expect(second.status === 'done' ? second.output : undefined).toEqual({
      draft: 'Draft: release notes',
    });
  });

  test('idle + resume: pre-idle side effects and model calls run exactly once, never re-executed on resume', async () => {
    // LangGraph's documented HITL gotcha: code before an inline interrupt()
    // re-executes when the node resumes, so side effects must be manually
    // isolated. Idle-first HITL cannot have this failure mode: the resumed
    // snapshot starts AT the idle state, so states before it never re-enter.
    // This test pins that guarantee.
    let sideEffectRuns = 0;
    let modelCalls = 0;

    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string(), draft: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ draft: z.string() }),
      events: { APPROVE: z.object({}), REJECT: z.object({}) },
    });

    const draftText = createTextLogic({
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.string(),
      },
      model: 'test-model',
      prompt: ({ input }) => input.topic,
    });

    const agent = setupAgent({
      schemas,
      actorSources: {
        draftText,
        recordAudit: createAsyncLogic<{ recorded: boolean }, unknown>({
          run: async () => {
            sideEffectRuns += 1;
            return { recorded: true };
          },
        }),
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, draft: null }),
      initial: 'auditing',
      states: {
        auditing: {
          invoke: {
            id: 'audit',
            src: 'recordAudit',
            onDone: { target: 'drafting' },
          },
        },
        drafting: {
          invoke: {
            id: 'draft',
            src: 'draftText',
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: 'awaitingApproval',
              context: { draft: output },
            }),
          },
        },
        awaitingApproval: {
          on: {
            APPROVE: { target: 'done' },
            REJECT: { target: 'drafting' },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ draft: context.draft ?? '' }),
        },
      },
    });

    const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => {
      modelCalls += 1;
      return { output: `Draft about ${request.prompt}` };
    };

    const first = await runAgent(machine, {
      input: { topic: 'incident recap' },
      generateText,
    });
    expect(first.status).toBe('idle');
    if (first.status !== 'idle') throw new Error('expected idle');
    expect(sideEffectRuns).toBe(1);
    expect(modelCalls).toBe(1);

    // Full JSON round-trip: the resume must not depend on live actor state.
    const persisted = JSON.parse(JSON.stringify(first.snapshot));

    const second = await runAgent(machine, {
      snapshot: persisted,
      event: { type: 'APPROVE' },
      generateText,
    });

    expect(second.status).toBe('done');
    expect(sideEffectRuns).toBe(1); // audit never re-ran
    expect(modelCalls).toBe(1); // draft never re-billed
    expect(second.status === 'done' ? second.output : undefined).toEqual({
      draft: 'Draft about incident recap',
    });

    // The loop is still real: an explicit REJECT deliberately re-enters
    // drafting, so the model runs again by AUTHORED choice, not by accident.
    const third = await runAgent(machine, {
      snapshot: persisted,
      event: { type: 'REJECT' },
      generateText,
    });
    expect(third.status).toBe('idle');
    expect(sideEffectRuns).toBe(1); // audit STILL exactly once
    expect(modelCalls).toBe(2); // redraft was an explicit transition
  });

  test('decision path: guard-rejected event retried, then completes; canTake wired through the live actor', async () => {
    const attackSchema = z.object({ target: z.string() });
    const healSchema = z.object({});

    const schemas = createAgentSchemas({
      context: z.object({ hp: z.number() }),
      input: z.object({}),
      events: { ATTACK: attackSchema, HEAL: healSchema },
    });

    const chooseMove = createDecisionLogic({
      model: 'test-model',
      prompt: 'Choose a move.',
      allowedEvents: ['ATTACK', 'HEAL'] as const,
    });

    const agent = setupAgent({ schemas, actorSources: { chooseMove } });
    const machine = agent.createMachine({
      context: { hp: 10 },
      initial: 'choosingMove',
      states: {
        choosingMove: {
          invoke: {
            id: 'choosingMove',
            src: 'chooseMove',
            input: {},
            onDone: sendDecision(),
            onError: { target: 'fumbled' },
          },
          on: {
            // HEAL only legal when hp < 5 — guard rejects it at hp = 10.
            HEAL: ({ context }) => (context.hp < 5 ? { target: 'healed' } : undefined),
            ATTACK: { target: 'attacked' },
          },
        },
        attacked: { type: 'final' },
        healed: {},
        fumbled: {},
      },
    });

    let callCount = 0;
    const requestsSeen: AgentDecisionRequest[] = [];
    const decide = async (
      request: AgentDecisionRequest
    ): Promise<{ event: ChosenEvent }> => {
      requestsSeen.push(request);
      callCount += 1;
      if (callCount === 1) {
        // Type + payload legal, but guard-rejected (hp is not < 5).
        return { event: { type: 'HEAL' } };
      }
      return { event: { type: 'ATTACK', target: 'goblin' } };
    };

    const result = await runAgent(machine, {
      input: {},
      generateText: async () => ({ output: {} }),
      decide,
    });

    expect(result.status).toBe('done');
    expect(callCount).toBe(2);
    expect(requestsSeen[1]!.attempts[0]!.failure).toBe('rejected-by-guard');
  });

  test('maxModelCalls: exceeding the budget settles a max-model-calls error', async () => {
    const schemas = createAgentSchemas({
      context: z.object({ count: z.number() }),
      input: z.object({}),
      output: z.object({ count: z.number() }),
    });

    const step = createTextLogic({
      schemas: {
        input: z.object({}),
        output: z.number(),
      },
      model: 'test-model',
    });

    const agent = setupAgent({ schemas, actorSources: { step } });
    const machine = agent.createMachine({
      context: { count: 0 },
      initial: 'looping',
      states: {
        looping: {
          invoke: {
            id: 'step',
            src: 'step',
            input: {},
            onDone: ({ output }) => ({
              target: 'looping',
              reenter: true,
              context: { count: output as number },
            }),
          },
        },
      },
    });

    let calls = 0;
    const result = await runAgent(machine, {
      input: {},
      maxModelCalls: 3,
      generateText: async () => {
        calls += 1;
        return { output: calls };
      },
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.cause : undefined).toBe('max-model-calls');
  });

  test('abort: a pre-aborted signal settles an aborted error', async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: 'test-model',
    });
    const agent = setupAgent({ schemas, actorSources: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: 'working',
      states: {
        working: {
          invoke: { id: 'step', src: 'step', input: {}, onDone: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    });

    const controller = new AbortController();
    controller.abort();

    const result = await runAgent(machine, {
      input: {},
      signal: controller.signal,
      generateText: async () => ({ output: {} }),
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.cause : undefined).toBe('aborted');
  });

  test('abort: aborting mid-run settles an aborted error', async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: 'test-model',
    });
    const agent = setupAgent({ schemas, actorSources: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: 'working',
      states: {
        working: {
          invoke: { id: 'step', src: 'step', input: {}, onDone: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    });

    const controller = new AbortController();
    const resultPromise = runAgent(machine, {
      input: {},
      signal: controller.signal,
      generateText: () =>
        new Promise((resolveExec) => {
          setTimeout(() => resolveExec({ output: {} }), 50);
        }),
    });
    setTimeout(() => controller.abort(), 5);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.cause : undefined).toBe('aborted');
  });

  test('machine error: an executor throw with no onError settles a machine error', async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: 'test-model',
    });
    const agent = setupAgent({ schemas, actorSources: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: 'working',
      states: {
        working: {
          invoke: { id: 'step', src: 'step', input: {}, onDone: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      generateText: async () => {
        throw new Error('boom');
      },
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.cause : undefined).toBe('machine');
    expect(
      result.status === 'error' && result.error instanceof Error
        ? result.error.message
        : undefined
    ).toBe('boom');
  });

  describe('bind-time throws', () => {
    test('a direct-object src with its own executor binds fine (no throw)', async () => {
      const summarize = createTextLogic(
        {
          schemas: {
            input: z.object({ topic: z.string() }),
            output: z.string(),
          },
          model: 'test-model',
          prompt: ({ input }) => input.topic,
        },
        async () => ({ output: 'a summary' })
      );

      const machine = setup({}).createMachine({
        id: 'direct-object',
        initial: 'working',
        states: {
          working: {
            invoke: {
              id: 'summarize',
              src: summarize,
              input: { topic: 'state machines' },
              onDone: { target: 'done' },
            },
          },
          done: { type: 'final' },
        },
      });

      const result = await runAgent(machine, {
        generateText: async () => ({ output: {} }),
      });
      expect(result.status).toBe('done');
    });

    test('a machine invoking a decision with no decide option throws naming the source', async () => {
      const schemas = createAgentSchemas({
        context: z.object({}),
        input: z.object({}),
        events: { ATTACK: z.object({}) },
      });
      const chooseMove = createDecisionLogic({ model: 'test-model' });
      const agent = setupAgent({ schemas, actorSources: { chooseMove } });
      const machine = agent.createMachine({
        context: {},
        initial: 'choosingMove',
        states: {
          choosingMove: {
            invoke: { id: 'choosingMove', src: 'chooseMove', input: {}, onDone: sendDecision() },
            on: { ATTACK: { target: 'done' } },
          },
          done: { type: 'final' },
        },
      });

      await expect(
        runAgent(machine, { input: {}, generateText: async () => ({ output: {} }) })
      ).rejects.toThrow(/chooseMove/);
    });

    test('a machine invoking agent.userInput with no userInput option settles idle with pendingUserInputs (blessed placeholder, not a bind error)', async () => {
      const schemas = createAgentSchemas({
        context: z.object({ feedback: z.string().nullable() }),
        input: z.object({}),
        output: z.object({}),
      });
      const agent = setupAgent({ schemas });
      const machine = agent.createMachine({
        context: { feedback: null },
        initial: 'asking',
        states: {
          asking: {
            invoke: {
              id: 'ask',
              src: 'agent.userInput',
              input: { prompt: 'How was it?' },
              onDone: { target: 'done' },
            },
          },
          done: { type: 'final' },
        },
      });

      const result = await runAgent(machine, {
        input: {},
        generateText: async () => ({ output: {} }),
      });

      expect(result.status).toBe('idle');
      if (result.status !== 'idle') throw new Error('expected idle');
      expect(result.pendingUserInputs).toEqual([
        { id: 'ask', input: { prompt: 'How was it?' } },
      ]);
      expect(result.persistedSnapshot).toBeDefined();
    });

    test('a machine invoking an unregistered string src throws naming the source', async () => {
      const machine = setup({}).createMachine({
        id: 'unregistered',
        initial: 'working',
        states: {
          working: {
            invoke: {
              id: 'x',
              src: 'notRegistered',
              onDone: { target: 'done' },
            } as never,
          },
          done: { type: 'final' },
        },
      });

      await expect(
        runAgent(machine, { input: undefined, generateText: async () => ({ output: {} }) })
      ).rejects.toThrow(/notRegistered/);
    });

    test('a STREAM-mode TextLogic invoke with no streamText option throws naming the source', async () => {
      const streamSummary = createTextLogic({
        mode: 'stream',
        schemas: { input: z.object({}), output: z.string() },
        model: 'test-model',
      });
      const agent = setupAgent({
        schemas: createAgentSchemas({ context: z.object({}), input: z.object({}) }),
        actorSources: { streamSummary },
      });
      const machine = agent.createMachine({
        context: {},
        initial: 'streaming',
        states: {
          streaming: {
            invoke: {
              id: 'streamSummary',
              src: 'streamSummary',
              input: {},
              onDone: { target: 'done' },
            },
          },
          done: { type: 'final' },
        },
      });

      await expect(
        runAgent(machine, { input: {}, generateText: async () => ({ output: {} }) })
      ).rejects.toThrow(/streamSummary/);
    });

    test('a direct-object invoke src that is an agent logic WITHOUT its own executor throws', async () => {
      const summarize = createTextLogic({
        schemas: { input: z.object({ topic: z.string() }), output: z.string() },
        model: 'test-model',
        prompt: ({ input }) => input.topic,
      });

      const machine = setup({}).createMachine({
        id: 'direct-object-no-executor',
        initial: 'working',
        states: {
          working: {
            invoke: {
              id: 'summarize',
              src: summarize,
              input: { topic: 'state machines' },
              onDone: { target: 'done' },
            },
          },
          done: { type: 'final' },
        },
      });

      await expect(
        runAgent(machine, { generateText: async () => ({ output: {} }) })
      ).rejects.toThrow(/direct-object/);
    });

    // A child machine whose states invoke agent requests is opaque to the
    // parent-level source walk. Child requests do NOT inherit the parent
    // runAgent's executors at runtime (verified by probe: an unbound child
    // request settles the run 'error'/parks it), so the bind walk must
    // descend into invoked child machines and fail fast when a child request
    // has no host execution of its own.
    describe('child-machine recursion', () => {
      // Builds a child machine that invokes `researchTopic` by name. When
      // `bindChildRequest` is true, the request carries its own executor
      // (via nested `.provide` + `.withExecutor`) so it runs itself.
      const makeChildMachine = (bindChildRequest: boolean, depth = 1) => {
        const researchTopic = createTextLogic({
          schemas: { input: z.object({ topic: z.string() }), output: z.string() },
          model: 'test-model',
          prompt: ({ input }) => input.topic,
        });
        const childAgent = setupAgent({
          context: z.object({ topic: z.string(), research: z.string().nullable() }),
          input: z.object({ topic: z.string() }),
          output: z.object({ research: z.string() }),
          actorSources: { researchTopic },
        });
        let childMachine = childAgent.createMachine({
          id: `child-${depth}`,
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
        if (bindChildRequest) {
          childMachine = childMachine.provide({
            actorSources: {
              researchTopic: researchTopic.withExecutor(async ({ input }) => ({
                output: `Research: ${input.topic}`,
              })),
            },
          });
        }
        return childMachine;
      };

      const makeParentMachine = (childMachine: ReturnType<typeof makeChildMachine>) => {
        const parentAgent = setupAgent({
          context: z.object({ topic: z.string(), research: z.string().nullable() }),
          input: z.object({ topic: z.string() }),
          output: z.object({ research: z.string() }),
          actorSources: { child: childMachine },
        });
        return parentAgent.createMachine({
          id: 'parent',
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
      };

      test('(1) an UNBOUND child request throws at bind time naming the child + request', async () => {
        const parentMachine = makeParentMachine(makeChildMachine(false));

        await expect(
          runAgent(parentMachine, {
            input: { topic: 'agents' },
            generateText: async () => ({ output: 'x' }),
          })
        ).rejects.toThrow(/child machine.*child.*researchTopic/s);

        // Message must point at the nested-.provide remedy and say executors
        // are not inherited.
        await expect(
          runAgent(parentMachine, {
            input: { topic: 'agents' },
            generateText: async () => ({ output: 'x' }),
          })
        ).rejects.toThrow(/do NOT inherit|withExecutor/);
      });

      test('(2) a properly-bound child (nested .provide + .withExecutor) runs to done', async () => {
        const parentMachine = makeParentMachine(makeChildMachine(true));

        const result = await runAgent(parentMachine, {
          input: { topic: 'agents' },
          // No decide/streamText; parent generateText is NOT what runs the
          // child request — the child's own bound executor does.
          generateText: async () => ({ output: 'unused' }),
        });

        expect(result.status).toBe('done');
        expect(result.status === 'done' ? result.output : undefined).toEqual({
          research: 'Research: agents',
        });
      });

      test('(3) grandchild depth: an unbound request in a child-of-child throws', async () => {
        // Grandchild (depth 2) has an unbound request; child (depth 1)
        // invokes the grandchild; parent invokes the child.
        const grandchild = makeChildMachine(false, 2);

        const midAgent = setupAgent({
          context: z.object({ topic: z.string(), research: z.string().nullable() }),
          input: z.object({ topic: z.string() }),
          output: z.object({ research: z.string() }),
          actorSources: { grandchild },
        });
        const midMachine = midAgent.createMachine({
          id: 'mid',
          context: ({ input }) => ({ topic: input.topic, research: null }),
          initial: 'delegating',
          states: {
            delegating: {
              invoke: {
                src: 'grandchild',
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

        const parentMachine = makeParentMachine(
          midMachine as unknown as ReturnType<typeof makeChildMachine>
        );

        await expect(
          runAgent(parentMachine, {
            input: { topic: 'agents' },
            generateText: async () => ({ output: 'x' }),
          })
        ).rejects.toThrow(/researchTopic/);
      });

      test('(4) a recursively self-invoking machine does not infinite-loop the bind walk', async () => {
        // A machine that invokes itself by name (cycle). The bind walk must
        // terminate via the visited-set guard rather than recurse forever.
        const selfAgent = setupAgent({
          context: z.object({ n: z.number() }),
          input: z.object({ n: z.number() }),
          output: z.object({}),
        });
        const selfMachine = selfAgent.createMachine({
          id: 'self',
          context: ({ input }) => ({ n: input.n }),
          initial: 'looping',
          states: {
            looping: {
              invoke: {
                src: 'self',
                input: ({ context }: { context: { n: number } }) => ({ n: context.n - 1 }),
                onDone: { target: 'done' },
              } as never,
            },
            done: { type: 'final', output: {} },
          },
        });
        // Make the 'self' source resolve to the machine itself, creating a
        // genuine identity cycle for the bind walk to guard against. Mutating
        // implementations in place (rather than .provide, which returns a new
        // object) keeps the invoked source === the machine being walked.
        (selfMachine.implementations.actorSources as Record<string, unknown>).self =
          selfMachine;

        // The point under test is the BIND walk (the visited-set guard): it
        // must return rather than recurse forever on the identity cycle. A
        // pre-aborted signal settles the run right after binding, so reaching
        // any settled result at all proves the bind walk terminated (an
        // infinite bind loop would throw a RangeError / hang before this).
        const result = await runAgent(selfMachine, {
          input: { n: 0 },
          signal: AbortSignal.abort(),
          generateText: async () => ({ output: 'x' }),
        });
        expect(['done', 'idle', 'error']).toContain(result.status);
      });
    });
  });

  test('after-timer: a pending after transition is not idle; runAgent resolves done', async () => {
    const machine = setup({}).createMachine({
      id: 'after-timer',
      initial: 'waiting',
      states: {
        waiting: {
          after: { 20: { target: 'done-state' } },
        },
        'done-state': { type: 'final' },
      },
    });

    const result = await runAgent(machine, {
      input: undefined,
      generateText: async () => ({ output: {} }),
    });

    expect(result.status).toBe('done');
  });

  test('onTransition: fires with the causing event type at least once', async () => {
    const machine = setup({}).createMachine({
      id: 'transition-observed',
      initial: 'a',
      states: {
        a: { on: { GO: { target: 'b' } } },
        b: { type: 'final' },
      },
    });

    const seenEventTypes: string[] = [];
    const result = await runAgent(machine, {
      input: undefined,
      event: { type: 'GO' },
      generateText: async () => ({ output: {} }),
      onTransition: (_snapshot, event) => {
        seenEventTypes.push(event.type);
      },
    });

    // A machine with no invokes and only an `on: { GO }` handler settles
    // idle before the event is sent unless sent as part of this same run;
    // runAgent sends options.event right after start(), so GO is applied.
    expect(result.status === 'done' || result.status === 'idle').toBe(true);
    expect(seenEventTypes).toContain('GO');
  });

  test('userInput: the userInput option resolves agent.userInput and the machine consumes it', async () => {
    const schemas = createAgentSchemas({
      context: z.object({ feedback: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ feedback: z.string() }),
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: { feedback: null },
      initial: 'asking',
      states: {
        asking: {
          invoke: {
            id: 'ask',
            src: 'agent.userInput',
            input: { prompt: 'How was it?' },
            onDone: ({ event }) => ({
              target: 'done',
              context: {
                feedback: (event.output as { feedback?: string }).feedback ?? '',
              },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ feedback: context.feedback ?? '' }),
        },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      generateText: async () => ({ output: {} }),
      userInput: async (input) => {
        expect(input).toEqual(expect.objectContaining({ prompt: 'How was it?' }));
        return { feedback: 'great' };
      },
    });

    expect(result.status).toBe('done');
    expect(result.status === 'done' ? result.output : undefined).toEqual({
      feedback: 'great',
    });
  });

  describe('omitted allowedEvents: "all currently-legal events"', () => {
    const attackSchema = z.object({ target: z.string() });
    const healSchema = z.object({});

    const schemas = createAgentSchemas({
      context: z.object({ hp: z.number() }),
      input: z.object({}),
      events: { ATTACK: attackSchema, HEAL: healSchema },
    });

    test('runAgent + inline agent.decide with allowedEvents omitted: candidates are exactly the legal events, with inputSchema attached', async () => {
      const agent = setupAgent({ schemas });
      const machine = agent.createMachine({
        context: { hp: 10 },
        initial: 'choosingMove',
        states: {
          choosingMove: {
            invoke: {
              id: 'choosingMove',
              // No allowedEvents — omitted means "all currently-legal events."
              src: 'agent.decide',
              input: { model: 'test-model', prompt: 'Choose a move.' },
              onDone: sendDecision(),
              onError: { target: 'fumbled' },
            },
            on: {
              // HEAL only legal when hp < 5 — type-legal but guard-narrowed here.
              HEAL: ({ context }) => (context.hp < 5 ? { target: 'healed' } : undefined),
              ATTACK: { target: 'attacked' },
            },
          },
          attacked: { type: 'final' },
          healed: {},
          fumbled: {},
        },
      });

      let seenEvents: readonly { type: string; inputSchema?: unknown }[] = [];
      const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
        seenEvents = request.events;
        return { event: { type: 'ATTACK', target: 'goblin' } };
      };

      const result = await runAgent(machine, {
        input: {},
        generateText: async () => ({ output: {} }),
        decide,
      });

      expect(result.status).toBe('done');
      expect(seenEvents.map((event) => event.type).sort()).toEqual(['ATTACK', 'HEAL']);
      expect(seenEvents.find((event) => event.type === 'ATTACK')?.inputSchema).toBe(
        attackSchema
      );
      expect(seenEvents.find((event) => event.type === 'HEAL')?.inputSchema).toBe(healSchema);
    });

    test('runAgent + createDecisionLogic actor with allowedEvents omitted: candidates are exactly the legal events', async () => {
      const chooseMove = createDecisionLogic({
        model: 'test-model',
        prompt: 'Choose a move.',
        // allowedEvents omitted.
      });

      const agent = setupAgent({ schemas, actorSources: { chooseMove } });
      const machine = agent.createMachine({
        context: { hp: 10 },
        initial: 'choosingMove',
        states: {
          choosingMove: {
            invoke: {
              id: 'choosingMove',
              src: 'chooseMove',
              input: {},
              onDone: sendDecision(),
              onError: { target: 'fumbled' },
            },
            on: {
              HEAL: ({ context }) => (context.hp < 5 ? { target: 'healed' } : undefined),
              ATTACK: { target: 'attacked' },
            },
          },
          attacked: { type: 'final' },
          healed: {},
          fumbled: {},
        },
      });

      let seenEvents: readonly { type: string }[] = [];
      const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
        seenEvents = request.events;
        return { event: { type: 'ATTACK', target: 'goblin' } };
      };

      const result = await runAgent(machine, {
        input: {},
        generateText: async () => ({ output: {} }),
        decide,
      });

      expect(result.status).toBe('done');
      expect(seenEvents.map((event) => event.type).sort()).toEqual(['ATTACK', 'HEAL']);
    });

    test('guard-narrowing still intact: a type-legal event offered as a candidate can still be canTake-rejected', async () => {
      const agent = setupAgent({ schemas });
      const machine = agent.createMachine({
        context: { hp: 10 },
        initial: 'choosingMove',
        states: {
          choosingMove: {
            invoke: {
              id: 'choosingMove',
              src: 'agent.decide',
              input: { model: 'test-model', prompt: 'Choose a move.' },
              onDone: sendDecision(),
              onError: { target: 'fumbled' },
            },
            on: {
              // HEAL is type-legal (a declared event) but guard-narrowed:
              // illegal at hp = 10, so the function-transition returns
              // undefined. It must still appear as a candidate (§2.7
              // type-only filter) even though canTake later rejects it
              // (mode-3).
              HEAL: ({ context }) => (context.hp < 5 ? { target: 'healed' } : undefined),
              ATTACK: { target: 'attacked' },
            },
          },
          attacked: { type: 'final' },
          healed: {},
          fumbled: {},
        },
      });

      let callCount = 0;
      const requestsSeen: AgentDecisionRequest[] = [];
      const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
        requestsSeen.push(request);
        callCount += 1;
        if (callCount === 1) {
          return { event: { type: 'HEAL' } };
        }
        return { event: { type: 'ATTACK', target: 'goblin' } };
      };

      const result = await runAgent(machine, {
        input: {},
        generateText: async () => ({ output: {} }),
        decide,
      });

      expect(result.status).toBe('done');
      expect(requestsSeen[0]!.events.map((event) => event.type).sort()).toEqual([
        'ATTACK',
        'HEAL',
      ]);
      expect(requestsSeen[1]!.attempts[0]!.failure).toBe('rejected-by-guard');
    });

    test('bare createActor + .withExecutor + allowedEvents omitted: rejects immediately with guidance, not DecisionExhaustedError', async () => {
      const chooseMove = createDecisionLogic(
        {
          model: 'test-model',
          prompt: 'Choose a move.',
          // allowedEvents omitted — unresolvable without a snapshot-aware host.
        },
        async () => ({ event: { type: 'ATTACK', target: 'goblin' } })
      );

      const actor = createActor(chooseMove, { input: {} });
      actor.subscribe({ error: () => {} });
      actor.start();

      await expect(toPromise(actor)).rejects.toThrow(
        /omitted `allowedEvents`.*snapshot-aware host/s
      );
    });
  });

  test('sendDecision: the decided event is delivered exactly once despite transition-fn re-evaluation', async () => {
    const schemas = createAgentSchemas({
      context: z.object({ attackCount: z.number() }),
      input: z.object({}),
      events: { ATTACK: z.object({}) },
    });

    const chooseMove = createDecisionLogic({
      model: 'test-model',
      prompt: 'Choose a move.',
      allowedEvents: ['ATTACK'] as const,
    });

    const agent = setupAgent({ schemas, actorSources: { chooseMove } });
    const machine = agent.createMachine({
      context: { attackCount: 0 },
      initial: 'choosingMove',
      states: {
        choosingMove: {
          invoke: {
            id: 'choosingMove',
            src: 'chooseMove',
            input: {},
            onDone: sendDecision(),
          },
          on: {
            // Counts how many times ATTACK is actually processed as an
            // event by the machine — re-evaluating the transition function
            // (spike S3: 8x) must not multiply delivery.
            ATTACK: ({ context }) => ({
              target: 'attacked',
              context: { attackCount: context.attackCount + 1 },
            }),
          },
        },
        attacked: { type: 'final' },
      },
    });

    let attackEventsObserved = 0;
    const result = await runAgent(machine, {
      input: {},
      generateText: async () => ({ output: {} }),
      decide: async () => ({ event: { type: 'ATTACK' } }),
      onTransition: (_snapshot, event) => {
        if (event.type === 'ATTACK') {
          attackEventsObserved += 1;
        }
      },
    });

    expect(result.status).toBe('done');
    expect(result.status === 'done' ? result.snapshot.context.attackCount : undefined).toBe(1);
    expect(attackEventsObserved).toBe(1);
  });
});

describe('agent.userInput as a pending placeholder (durable parallel HITL)', () => {
  const schemas = createAgentSchemas({
    context: z.object({
      summary: z.string().nullable(),
      feedback: z.string().nullable(),
    }),
    input: z.object({}),
    output: z.object({ summary: z.string(), feedback: z.string() }),
  });

  const agent = setupAgent({
    schemas,
    requests: {
      summarize: {
        schemas: { input: z.object({}), output: z.string() },
        model: 'm',
        prompt: () => 'summarize',
      },
    },
  });

  const machine = agent.createMachine({
    context: { summary: null, feedback: null },
    type: 'parallel',
    output: ({ context }) => ({
      summary: context.summary ?? '',
      feedback: context.feedback ?? '',
    }),
    states: {
      working: {
        initial: 'summarizing',
        states: {
          summarizing: {
            invoke: {
              id: 'sum',
              src: 'summarize',
              input: {},
              onDone: ({ output }) => ({
                target: 'summarized',
                context: { summary: output },
              }),
            },
          },
          summarized: { type: 'final' },
        },
      },
      reviewing: {
        initial: 'asking',
        states: {
          asking: {
            invoke: {
              id: 'askHuman',
              src: 'agent.userInput',
              input: { prompt: 'Feedback?' },
              onDone: ({ output }) => ({
                target: 'received',
                context: { feedback: (output as { feedback: string }).feedback },
              }),
            },
          },
          received: { type: 'final' },
        },
      },
    },
  });

  test('a sibling region finishes its model call, then the run settles idle with the pending user input', async () => {
    const result = await runAgent(machine, {
      input: {},
      generateText: async () => ({ output: 'a summary' }),
    });

    expect(result.status).toBe('idle');
    if (result.status !== 'idle') throw new Error('expected idle');
    // The sibling region's work ran to completion before settling.
    expect((result.snapshot.context as { summary: string | null }).summary).toBe(
      'a summary'
    );
    expect(result.pendingUserInputs).toEqual([
      { id: 'askHuman', input: { prompt: 'Feedback?' } },
    ]);
    expect(result.persistedSnapshot).toBeDefined();
  });

  test('the persisted snapshot JSON round-trips and resumes with a userInput handler to done', async () => {
    const first = await runAgent(machine, {
      input: {},
      generateText: async () => ({ output: 'a summary' }),
    });
    if (first.status !== 'idle' || !first.persistedSnapshot) {
      throw new Error('expected idle with persistedSnapshot');
    }

    const stored = JSON.parse(JSON.stringify(first.persistedSnapshot));

    const second = await runAgent(machine, {
      snapshot: stored,
      generateText: async () => {
        throw new Error('no model call expected on resume');
      },
      userInput: async (input) => {
        expect(input).toEqual({ prompt: 'Feedback?' });
        return { feedback: 'ship it' };
      },
    });

    expect(second.status).toBe('done');
    if (second.status !== 'done') throw new Error('expected done');
    expect(second.output).toEqual({ summary: 'a summary', feedback: 'ship it' });
  });

  test('resuming without a handler settles idle again with the same pending input', async () => {
    const first = await runAgent(machine, {
      input: {},
      generateText: async () => ({ output: 'a summary' }),
    });
    if (first.status !== 'idle' || !first.persistedSnapshot) {
      throw new Error('expected idle with persistedSnapshot');
    }

    const again = await runAgent(machine, {
      snapshot: JSON.parse(JSON.stringify(first.persistedSnapshot)),
      generateText: async () => ({ output: 'unused' }),
    });

    expect(again.status).toBe('idle');
    if (again.status !== 'idle') throw new Error('expected idle');
    expect(again.pendingUserInputs).toEqual([
      { id: 'askHuman', input: { prompt: 'Feedback?' } },
    ]);
  });
});
