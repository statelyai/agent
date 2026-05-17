import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  classify,
  classifyResultSchema,
  createAgentMachine,
  createAdapter,
  decide,
  decideResultSchema,
} from './index.js';
import type { DecideAdapter } from './types.js';

// ─── Test helpers ───

function mockAdapter(
  responses: Array<{
    choice: string;
    data?: Record<string, unknown>;
    reasoning?: string;
  }>
): DecideAdapter {
  let index = 0;
  return {
    decide: async () => {
      const response = responses[index++];
      if (!response) throw new Error('No more mock responses');
      return {
        choice: response.choice,
        data: response.data ?? {},
        reasoning: response.reasoning,
      };
    },
  };
}

const choiceResultSchema = z.object({
  choice: z.string(),
  data: z.record(z.string(), z.unknown()),
  reasoning: z.string().optional(),
});

// ─── Simple machine (no schemas — inferred from context) ───

function createSimpleMachine() {
  return createAgentMachine({
    id: 'simple',
    context: () => ({ count: 0 }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          start: ({ target: 'running' }),
        },
      },
      running: {
        schemas: { output: z.object({ value: z.number() }) },
        invoke: async ({ context }) => {
          // context.count is typed as number ✓
          return { value: context.count + 1 };
        },
        onDone: ({ output }) => ({
          target: 'done',
          context: { count: output.value },
        }),
      },
      done: {
        type: 'final',
        // is the machine output inferred? should we have top-level outputSchema?
        output: ({ context }) => ({ result: context.count }),
      },
    },
  });
}

// ─── HITL machine (with schemas) ───

function createHitlMachine() {
  return createAgentMachine({
    id: 'hitl',
    schemas: {
      input: z.object({ task: z.string() }),
      events: {
        'user.message': z.object({ message: z.string() }),
        'user.approve': z.object({}),
        'user.cancel': z.object({}),
      },
    },
    context: (input) => ({
      task: input.task,
      messages: [] as Array<{ role: string; content: string }>,
      result: null as string | null,
    }),
    initial: 'gathering',
    states: {
      gathering: {
        on: {
          // events are now typed from schemas.events
          'user.message': ({ event, context }) => ({
            context: {
              messages: [
                ...context.messages,
                { role: 'user', content: event.message },
              ],
            },
          }),
          // static shorthand — string target
          'user.approve': { target: 'processing' },
          'user.cancel': { target: 'cancelled' },
        },
      },
      processing: {
        schemas: { output: z.object({ output: z.string() }) },
        invoke: async ({ context }) => {
          // context.messages is typed ✓
          return {
            output: `Processed: ${context.messages.map((m) => m.content).join(', ')}`,
          };
        },
        onDone: ({ output }) => ({
          target: 'reviewing',
          context: { result: output.output },
        }),
      },
      reviewing: {
        on: {
          // static shorthand — object target
          'user.approve': { target: 'done' },
          'user.message': ({ event, context }) => ({
            target: 'processing',
            context: {
              messages: [
                ...context.messages,
                { role: 'user', content: event.message },
              ],
            },
          }),
          'user.cancel': { target: 'cancelled' },
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ result: context.result }),
      },
      cancelled: {
        type: 'final',
        output: () => ({ cancelled: true }),
      },
    },
  });
}

// ─── Decide machine ───

function createDecideMachine(adapter: DecideAdapter) {
  const options = {
    billing: { description: 'Billing issues' },
    technical: { description: 'Technical issues' },
    general: { description: 'General inquiries' },
  } as const;

  return createAgentMachine({
    id: 'decider',
    context: () => ({
      issue: 'App crashes on login',
      category: null as string | null,
      resolution: null as string | null,
    }),
    initial: 'classifying',
    states: {
      classifying: {
        schemas: { output: decideResultSchema(options) },
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'test-model',
            prompt: `Classify: ${context.issue}`,
            options,
          }),
        onDone: ({ output }) => ({
          target: 'handling',
          context: { category: output.choice },
        }),
      },
      handling: {
        schemas: { output: z.object({ resolution: z.string() }) },
        invoke: async ({ context }) => ({
          resolution: `Handled ${context.category} issue`,
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { resolution: output.resolution },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          category: context.category,
          resolution: context.resolution,
        }),
      },
    },
  });
}

// ─── Classify machine ───

function createClassifyMachine(adapter: DecideAdapter) {
  const categories = {
    billing: { description: 'Billing, payments, refunds' },
    technical: { description: 'Technical issues, bugs' },
    general: { description: 'General inquiries' },
  } as const;

  return createAgentMachine({
    id: 'classifier',
    context: () => ({
      issue: 'I want my money back',
      category: null as string | null,
    }),
    initial: 'classifyIntent',
    states: {
      classifyIntent: {
        schemas: { output: classifyResultSchema(categories) },
        invoke: async ({ context }) =>
          classify({
            adapter,
            model: 'test-model',
            prompt: `Classify: "${context.issue}"`,
            into: categories,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { category: output.category },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ category: context.category }),
      },
    },
  });
}


// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

describe('createAgentMachine', () => {
  test('returns machine with typed methods', () => {
    const machine = createSimpleMachine();
    expect(machine.id).toBe('simple');
    expect(typeof machine.getInitialState).toBe('function');
    expect(typeof machine.transition).toBe('function');
    expect(typeof machine.invoke).toBe('function');
    expect(typeof machine.execute).toBe('function');
    expect(typeof machine.stream).toBe('function');
    expect(typeof machine.resolveState).toBe('function');
  });
});

describe('getInitialState', () => {
  test('creates initial state (sync)', () => {
    const machine = createSimpleMachine();
    const state = machine.getInitialState();
    expect(state.value).toBe('idle');
    expect(state.context).toEqual({ count: 0 });
    expect(state.status).toBe('active');
  });

  test('validates input via schemas.input (sync)', () => {
    const machine = createHitlMachine();
    const state = machine.getInitialState({ task: 'test task' });
    expect(state.context.task).toBe('test task');
  });

  test('rejects invalid input', () => {
    const machine = createHitlMachine();
    // Runtime validation catches invalid input (schemas.input validates)
    const invalidInput = { task: 123 } as unknown as { task: string };
    expect(() => machine.getInitialState(invalidInput)).toThrow();
  });

  test('resolves string initial', () => {
    const machine = createSimpleMachine();
    expect(machine.getInitialState().value).toBe('idle');
  });

  test('resolves function initial', () => {
    const machine = createAgentMachine({
      id: 'fn-initial',
      context: (input: string) => ({ mode: input }),
      initial: ({ context }) => ({
        target: (context.mode === 'fast' ? 'fast' : 'slow') as 'fast' | 'slow',
      }),
      states: {
        fast: { type: 'final' },
        slow: { type: 'final' },
      },
    });
    expect(machine.getInitialState('fast').value).toBe('fast');
  });

});

describe('invoke', () => {
  test('executes invoke and transitions via onDone', async () => {
    const machine = createSimpleMachine();
    let state = machine.getInitialState();
    state = machine.transition(state, { type: 'start' });
    state = await machine.invoke(state);
    expect(state.value).toBe('done');
    expect(state.context.count).toBe(1);
  });

  test('returns pending for event-only states', async () => {
    const machine = createHitlMachine();
    const state = await machine.invoke(machine.getInitialState({ task: 'x' }));
    expect(state.status).toBe('pending');
    expect(state.value).toBe('gathering');
  });

  test('returns done for final states', async () => {
    const machine = createSimpleMachine();
    let s = machine.transition(machine.getInitialState(), { type: 'start' });
    s = await machine.invoke(s);
    s = await machine.invoke(s);
    expect(s.status).toBe('done');
    expect(s.output).toEqual({ result: 1 });
  });

  test('handles decide with adapter', async () => {
    const machine = createDecideMachine(
      mockAdapter([{ choice: 'technical' }])
    );
    const s = await machine.invoke(machine.getInitialState());
    expect(s.value).toBe('handling');
    expect(s.context.category).toBe('technical');
  });

  test('handles classify', async () => {
    const machine = createClassifyMachine(
      mockAdapter([{ choice: 'billing' }])
    );
    const s = await machine.invoke(machine.getInitialState());
    expect(s.value).toBe('done');
    expect(s.context.category).toBe('billing');
  });

  test('errors without adapter', async () => {
    const machine = createAgentMachine({
      id: 'no-adapter',
      context: () => ({}),
      initial: 'deciding',
      states: {
        deciding: {
          invoke: async () =>
            decide({
              model: 'test',
              prompt: 'test',
              options: { a: { description: 'A' } },
            }),
          onDone: () => ({ target: 'done' }),
        },
        done: { type: 'final' },
      },
    });
    const s = await machine.invoke(machine.getInitialState());
    expect(s.status).toBe('error');
  });

  test('catches invoke errors', async () => {
    const machine = createAgentMachine({
      id: 'err',
      context: () => ({}),
      initial: 'fail',
      states: {
        fail: {
          invoke: async () => {
            throw new Error('boom');
          },
          onDone: () => ({ target: 'ok' }),
        },
        ok: { type: 'final' },
      },
    });
    const s = await machine.invoke(machine.getInitialState());
    expect(s.status).toBe('error');
    expect((s.error as Error).message).toBe('boom');
  });

});

describe('transition', () => {
  test('transitions on matching event', () => {
    const machine = createSimpleMachine();
    const s = machine.transition(machine.getInitialState(), { type: 'start' });
    expect(s.value).toBe('running');
    expect(s.status).toBe('active');
  });

  test('self-transition (no target)', async () => {
    const machine = createHitlMachine();
    let s = await machine.invoke(machine.getInitialState({ task: 'x' }));
    s = machine.transition(s, { type: 'user.message', message: 'hello' });
    expect(s.value).toBe('gathering');
    expect(s.context.messages[0]!.content).toBe('hello');
  });

  test('accumulates context', async () => {
    const machine = createHitlMachine();
    let s = await machine.invoke(machine.getInitialState({ task: 'x' }));
    s = machine.transition(s, { type: 'user.message', message: 'one' });
    s = machine.transition(s, { type: 'user.message', message: 'two' });
    expect(s.context.messages.length).toBe(2);
  });

  test('throws on unknown event', () => {
    const machine = createSimpleMachine();
    expect(() =>
      machine.transition(machine.getInitialState(), { type: 'nope' })
    ).toThrow("No handler for event 'nope'");
  });

});

describe('execute', () => {
  test('runs until done', async () => {
    const machine = createSimpleMachine();
    let s = machine.transition(machine.getInitialState(), { type: 'start' });
    const r = await machine.execute(s);
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.output).toEqual({ result: 1 });
      expect(r.context.count).toBe(1);
    }
  });

  test('stops at pending', async () => {
    const machine = createHitlMachine();
    const r = await machine.execute(machine.getInitialState({ task: 'x' }));
    expect(r.status).toBe('pending');
    if (r.status === 'pending') {
      expect(r.value).toBe('gathering');
      expect(r.events['user.message']).toBeDefined();
    }
  });

  test('stops on error', async () => {
    const machine = createAgentMachine({
      id: 'err',
      context: () => ({}),
      initial: 'fail',
      states: {
        fail: {
          invoke: async () => {
            throw new Error('nope');
          },
          onDone: () => ({ target: 'ok' }),
        },
        ok: { type: 'final' },
      },
    });
    const r = await machine.execute(machine.getInitialState());
    expect(r.status).toBe('error');
  });

  test('runs through multiple transitions', async () => {
    const machine = createDecideMachine(
      mockAdapter([{ choice: 'technical' }])
    );
    const r = await machine.execute(machine.getInitialState());
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.output).toEqual({
        category: 'technical',
        resolution: 'Handled technical issue',
      });
    }
  });

});

describe('stream', () => {
  test('yields snapshots', async () => {
    const machine = createDecideMachine(
      mockAdapter([{ choice: 'technical' }])
    );
    const snaps = [];
    for await (const snap of machine.stream(machine.getInitialState())) {
      snaps.push(snap);
    }
    expect(snaps.length).toBeGreaterThanOrEqual(3);
    expect(snaps[0]!.value).toBe('classifying');
    expect(snaps[snaps.length - 1]!.status).toBe('done');
  });
});

describe('resolveState', () => {
  test('restores from JSON', async () => {
    const machine = createHitlMachine();
    const r = await machine.execute(machine.getInitialState({ task: 'x' }));
    const restored = machine.resolveState(JSON.parse(JSON.stringify(r.state)));
    const next = machine.transition(restored, {
      type: 'user.message',
      message: 'restored',
    });
    expect(next.context.messages[0]!.content).toBe('restored');
  });

});

describe('decide', () => {
  test('calls adapter with resolved prompt', async () => {
    const spy = vi.fn().mockResolvedValue({ choice: 'a', data: {} });
    const machine = createAgentMachine({
      id: 'dtest',
      context: () => ({ topic: 'cats', choice: null as string | null }),
      initial: 'choosing',
      states: {
        choosing: {
          schemas: { output: decideResultSchema({
            a: { description: 'A' },
            b: { description: 'B' },
          }) },
          invoke: async ({ context }) =>
            decide({
              adapter: { decide: spy },
              model: 'my-model',
              prompt: `About ${context.topic}`,
              options: { a: { description: 'A' }, b: { description: 'B' } },
            }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { choice: output.choice },
          }),
        },
        done: { type: 'final' },
      },
    });
    await machine.invoke(machine.getInitialState());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'my-model', prompt: 'About cats' })
    );
  });

  test('per-state adapter override', async () => {
    const machine = createAgentMachine({
      id: 'override',
      context: () => ({ choice: null as string | null }),
      initial: 'choosing',
      states: {
        choosing: {
          schemas: { output: decideResultSchema({
            state: { description: 'State' },
            machine: { description: 'Machine' },
          }) },
          invoke: async () =>
            decide({
              adapter: mockAdapter([{ choice: 'state' }]),
              model: 'test',
              prompt: 'pick',
              options: {
                state: { description: 'State' },
                machine: { description: 'Machine' },
              },
            }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { choice: output.choice },
          }),
        },
        done: { type: 'final' },
      },
    });
    const r = await machine.execute(machine.getInitialState());
    expect(r.status === 'done' && r.context.choice).toBe('state');
  });

  test('option schemas typed data', async () => {
    const machine = createAgentMachine({
      id: 'data',
      context: () => ({ items: null as string[] | null }),
      initial: 'choosing',
      states: {
        choosing: {
          schemas: { output: decideResultSchema({
            withData: {
              description: 'Has data',
              schema: z.object({ items: z.array(z.string()) }),
            },
            withoutData: { description: 'No data' },
          }) },
          invoke: async () =>
            decide({
              adapter: {
                decide: async () => ({
                  choice: 'withData',
                  data: { items: ['a', 'b'] },
                }),
              },
              model: 'test',
              prompt: 'pick',
              options: {
                withData: {
                  description: 'Has data',
                  schema: z.object({ items: z.array(z.string()) }),
                },
                withoutData: { description: 'No data' },
              },
            }),
          onDone: ({ output }) => {
            return {
              target: 'done',
              context: {
                items:
                  output.choice === 'withData'
                    ? (output.data.items ?? null)
                    : null,
              },
            };
          },
        },
        done: { type: 'final' },
      },
    });
    const r = await machine.execute(machine.getInitialState());
    expect(r.status === 'done' && r.context.items).toEqual(['a', 'b']);
  });
});

describe('decide helper', () => {
  test('explicit decide invoke with typed context', async () => {
    const adapter = mockAdapter([{ choice: 'technical' }]);
    const machine = createAgentMachine({
      id: 'decide-helper-test',
      context: () => ({ issue: 'App crashes', result: null as string | null }),
      initial: 'routing',
      states: {
        routing: {
          schemas: { output: choiceResultSchema },
          invoke: async ({ context }) =>
            decide({
              adapter,
              model: 'test-model',
              prompt: `Route: ${context.issue}`,
              options: {
                billing: { description: 'Billing' },
                technical: { description: 'Technical' },
              },
            }),
          onDone: ({ output, context }) => ({
            target: 'done',
            context: { result: `${output.choice}: ${context.issue}` },
          }),
        },
        done: { type: 'final', output: ({ context }) => ({ result: context.result }) },
      },
    });

    const r = await machine.execute(machine.getInitialState());
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.output).toEqual({ result: 'technical: App crashes' });
    }
  });

  test('invoke state with event transition', () => {
    let called = false;
    const adapter: DecideAdapter = {
      decide: async () => {
        called = true;
        return { choice: 'a', data: {} };
      },
    };
    const machine = createAgentMachine({
      id: 'invoke-event-transition',
      context: () => ({}),
      initial: 'choosing',
      states: {
        choosing: {
          schemas: { output: choiceResultSchema },
          invoke: async () =>
            decide({
              adapter,
              model: 'test',
              prompt: 'pick',
              options: { a: { description: 'A' } },
            }),
          onDone: () => ({ target: 'done' }),
          on: {
            cancel: () => ({ target: 'cancelled' }),
          },
        },
        done: { type: 'final' },
        cancelled: { type: 'final' },
      },
    });

    const state = machine.getInitialState();
    const next = machine.transition(state, { type: 'cancel' });
    expect(next.value).toBe('cancelled');
    expect(called).toBe(false);
  });
});

describe('messages and always', () => {
  test('states expose resolved generation fields', () => {
    const search = async () => 'result';
    const machine = createAgentMachine({
      id: 'generation-fields',
      schemas: {
        input: z.object({ task: z.string() }),
      },
      context: (input) => ({ task: input.task, phase: 'read' }),
      messages: (input) => [{ role: 'user', content: input.task }],
      initial: 'planning',
      states: {
        planning: {
          model: 'test-model',
          system: 'Plan carefully.',
          prompt: ({ context }) => `Plan: ${context.task}`,
          tools: { search },
          toolChoice: 'auto',
          on: {
            ready: {
              target: 'implementing',
              context: { phase: 'write' },
              messages: [
                {
                  role: 'system',
                  content: 'Writing is allowed now.',
                },
              ],
            },
          },
        },
        implementing: {
          prompt: ({ context }) => `Implement: ${context.task}`,
          tools: {
            writeFile: async () => 'ok',
          },
          on: {
            done: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });

    const planning = machine.getInitialState({ task: 'Fix bug' });
    expect(planning.prompt).toBe('Plan: Fix bug');
    expect(planning.model).toBe('test-model');
    expect(planning.system).toBe('Plan carefully.');
    expect(Object.keys(planning.tools ?? {})).toEqual(['search', 'event.ready']);
    expect(planning.toolChoice).toBe('auto');

    const implementing = machine.transition(planning, { type: 'ready' });
    expect(implementing.prompt).toBe('Implement: Fix bug');
    expect(implementing.model).toBeUndefined();
    expect(Object.keys(implementing.tools ?? {})).toEqual([
      'writeFile',
      'event.done',
    ]);
    expect(implementing.messages.at(-1)).toEqual({
      role: 'system',
      content: 'Writing is allowed now.',
    });
  });

  test('generation fields resolve from the unresolved snapshot', () => {
    const read = async () => 'read';
    const write = async () => 'write';
    const seenSnapshots: Array<{
      value: string;
      hasPrompt: boolean;
      hasTools: boolean;
    }> = [];
    const machine = createAgentMachine({
      id: 'snapshot-resolvers',
      schemas: {
        input: z.object({ task: z.string(), mode: z.enum(['read', 'write']) }),
      },
      context: (input) => ({ task: input.task, mode: input.mode }),
      messages: (input) => [{ role: 'user', content: `Task: ${input.task}` }],
      initial: 'working',
      states: {
        working: {
          model: ({ snapshot }) =>
            snapshot.context.mode === 'write' ? 'write-model' : 'read-model',
          system: ({ snapshot }) => `State: ${snapshot.value}`,
          prompt: ({ snapshot }) => {
            seenSnapshots.push({
              value: snapshot.value,
              hasPrompt: 'prompt' in snapshot,
              hasTools: 'tools' in snapshot,
            });

            return [
              `Mode: ${snapshot.context.mode}`,
              `Messages: ${snapshot.messages.length}`,
              `Task: ${snapshot.context.task}`,
            ].join('\n');
          },
          tools: ({ snapshot }) =>
            snapshot.context.mode === 'write' ? { read, write } : { read },
          toolChoice: ({ snapshot }) =>
            snapshot.context.mode === 'write' ? 'required' : 'auto',
          on: {
            done: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });

    const state = machine.getInitialState({ task: 'Fix bug', mode: 'write' });

    expect(state.model).toBe('write-model');
    expect(state.system).toBe('State: working');
    expect(state.prompt).toBe('Mode: write\nMessages: 1\nTask: Fix bug');
    expect(Object.keys(state.tools ?? {})).toEqual(['read', 'write', 'event.done']);
    expect(state.toolChoice).toBe('required');
    expect(seenSnapshots).toEqual([
      {
        value: 'working',
        hasPrompt: false,
        hasTools: false,
      },
    ]);
  });

  test('event tools are namespaced and use event schemas', async () => {
    const userTool = async () => 'user tool';
    const machine = createAgentMachine({
      id: 'event-tools',
      schemas: {
        events: {
          PLAN_READY: z.object({
            type: z.literal('PLAN_READY'),
            rationale: z.string(),
          }),
        },
      },
      context: () => ({}),
      initial: 'planning',
      states: {
        planning: {
          tools: { PLAN_READY: userTool },
          on: {
            PLAN_READY: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });

    const state = machine.getInitialState();
    expect(state.tools?.PLAN_READY).toBe(userTool);
    expect(state.tools?.['event.PLAN_READY']).toMatchObject({
      description: "Transition with event 'PLAN_READY'.",
      schemas: { input: expect.any(Object) },
    });

    const eventTool = state.tools?.['event.PLAN_READY'] as {
      execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    await expect(
      eventTool.execute({ rationale: 'plan is ready' })
    ).resolves.toEqual({
      type: 'PLAN_READY',
      rationale: 'plan is ready',
    });
  });

  test('prompt states with no user tools still expose event tools', () => {
    const machine = createAgentMachine({
      id: 'event-only-tools',
      context: () => ({}),
      initial: 'waiting',
      states: {
        waiting: {
          prompt: 'Wait for completion.',
          on: {
            done: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });

    expect(Object.keys(machine.getInitialState().tools ?? {})).toEqual([
      'event.done',
    ]);
  });

  test('on events become prefixed event tools in prompt states by default', () => {
    const machine = createAgentMachine({
      id: 'prefixed-event-tools',
      context: () => ({}),
      initial: 'planning',
      states: {
        planning: {
          prompt: 'Plan and choose a transition.',
          on: {
            PLAN_READY: { target: 'done' },
            FAIL: { target: 'failed' },
          },
        },
        done: { type: 'final' },
        failed: { type: 'final' },
      },
    });

    expect(Object.keys(machine.getInitialState().tools ?? {})).toEqual([
      'event.PLAN_READY',
      'event.FAIL',
    ]);
  });

  test('non-generative states do not expose on events as tools', () => {
    const machine = createAgentMachine({
      id: 'non-generative-events',
      context: () => ({}),
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            APPROVED: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });

    const waiting = machine.getInitialState();
    expect(waiting.tools).toBeUndefined();

    const done = machine.transition(waiting, { type: 'APPROVED' });
    expect(done.value).toBe('done');
  });

  test('external events are valid transitions but excluded from event tools', () => {
    const machine = createAgentMachine({
      id: 'external-events',
      externalEvents: ['APPROVED', 'REJECTED'],
      schemas: {
        events: {
          PLAN_READY: z.object({}),
          APPROVED: z.object({}),
          REJECTED: z.object({}),
        },
      },
      context: () => ({}),
      initial: 'planning',
      states: {
        planning: {
          prompt: 'Prepare a plan.',
          on: {
            PLAN_READY: { target: 'awaitingApproval' },
          },
        },
        awaitingApproval: {
          prompt: 'Wait for approval.',
          on: {
            APPROVED: { target: 'done' },
            REJECTED: { target: 'planning' },
          },
        },
        done: { type: 'final' },
      },
    });

    const planning = machine.getInitialState();
    expect(Object.keys(planning.tools ?? {})).toEqual(['event.PLAN_READY']);

    const awaitingApproval = machine.transition(planning, {
      type: 'PLAN_READY',
    });
    expect(awaitingApproval.value).toBe('awaitingApproval');
    expect(awaitingApproval.tools).toBeUndefined();

    const done = machine.transition(awaitingApproval, { type: 'APPROVED' });
    expect(done.value).toBe('done');
  });

  test('invoke cannot be combined with generation fields', () => {
    expect(() =>
      createAgentMachine({
        id: 'invoke-generation-conflict',
        context: () => ({}),
        initial: 'working',
        states: {
          working: {
            prompt: 'Generate something.',
            invoke: async () => ({}),
          },
        },
      })
    ).toThrow(
      "State 'working' cannot combine invoke with prompt, system, tools, or toolChoice"
    );
  });

  test('snapshots omit executable generation fields', async () => {
    const machine = createAgentMachine({
      id: 'snapshot-generation-fields',
      context: () => ({}),
      initial: 'waiting',
      states: {
        waiting: {
          prompt: 'Use the tool.',
          tools: { search: async () => 'result' },
          on: { done: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    });

    const state = machine.getInitialState();
    expect(state.prompt).toBe('Use the tool.');
    expect(state.tools).toBeDefined();

    const snapshots = [];
    for await (const snapshot of machine.stream(state)) {
      snapshots.push(snapshot);
      break;
    }

    expect(snapshots[0]).not.toHaveProperty('prompt');
    expect(snapshots[0]).not.toHaveProperty('tools');
  });

  test('messages are passed through invoke, onDone, always, and output', async () => {
    const machine = createAgentMachine({
      id: 'messages-always',
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: z.object({
          messages: z.array(z.object({ role: z.string(), content: z.string() })),
          attempts: z.number(),
        }),
      },
      context: () => ({
        attempts: 0,
        accepted: false,
      }),
      messages: (input) => [{ role: 'user', content: input.prompt }],
      initial: 'generating',
      states: {
        generating: {
          schemas: { output: z.object({ text: z.string() }) },
          invoke: async ({ messages }) => ({
            text: `reply to ${messages.at(-1)?.content}`,
          }),
          onDone: ({ output, context, messages }) => ({
            target: 'checking',
            context: { attempts: context.attempts + 1 },
            messages: messages.concat({
              role: 'assistant',
              content: output.text,
            }),
          }),
        },
        checking: {
          always: ({ context, messages }) =>
            context.attempts >= 2
              ? {
                  target: 'done',
                  context: { accepted: true },
                  messages: messages.concat({
                    role: 'system',
                    content: 'accepted',
                  }),
                }
              : {
                  target: 'generating',
                  messages: messages.concat({
                    role: 'user',
                    content: 'repair',
                  }),
                },
        },
        done: {
          type: 'final',
          output: ({ context, messages }) => ({
            messages,
            attempts: context.attempts,
          }),
        },
      },
    });

    const result = await machine.execute(machine.getInitialState({ prompt: 'draft' }));

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.messages.map((message) => message.content)).toEqual([
        'draft',
        'reply to draft',
        'repair',
        'reply to repair',
        'accepted',
      ]);
      expect(result.output.attempts).toBe(2);
    }
  });
});

describe('classify', () => {
  test('result has typed category', async () => {
    const machine = createClassifyMachine(
      mockAdapter([{ choice: 'billing' }])
    );
    const r = await machine.execute(machine.getInitialState());
    expect(r.status === 'done' && r.output).toEqual({ category: 'billing' });
  });
});

describe('P2: event validation', () => {
  test('rejects invalid payload', async () => {
    const machine = createHitlMachine();
    const s = await machine.invoke(machine.getInitialState({ task: 'x' }));
    expect(() =>
      // @ts-expect-error — deliberately invalid for runtime test
      machine.transition(s, { type: 'user.message', message: 123 })
    ).toThrow();
  });

  test('accepts valid payload', async () => {
    const machine = createHitlMachine();
    const s = await machine.invoke(machine.getInitialState({ task: 'x' }));
    const next = machine.transition(s, {
      type: 'user.message',
      message: 'ok',
    });
    expect(next.context.messages.length).toBe(1);
  });

  test('skips when no schema', () => {
    const machine = createSimpleMachine();
    const s = machine.transition(machine.getInitialState(), { type: 'start' });
    expect(s.value).toBe('running');
  });
});

describe('full HITL workflow', () => {
  test('gather → process → review → done', async () => {
    const machine = createHitlMachine();
    let s = machine.getInitialState({ task: 'build' });
    let r = await machine.execute(s);
    expect(r.status).toBe('pending');

    s = machine.transition(r.state, {
      type: 'user.message',
      message: 'req A',
    });
    s = machine.transition(s, { type: 'user.message', message: 'req B' });
    s = machine.transition(s, { type: 'user.approve' });
    r = await machine.execute(s);
    expect(r.status === 'pending' && r.context.result).toBe(
      'Processed: req A, req B'
    );

    s = machine.transition(r.state, { type: 'user.approve' });
    r = await machine.execute(s);
    expect(r.status === 'done' && r.output).toEqual({
      result: 'Processed: req A, req B',
    });
  });

  test('cancel', async () => {
    const machine = createHitlMachine();
    let r = await machine.execute(machine.getInitialState({ task: 'x' }));
    const s = machine.transition(r.state, { type: 'user.cancel' });
    r = await machine.execute(s);
    expect(r.status === 'done' && r.output).toEqual({ cancelled: true });
  });
});

describe('type inference', () => {
  // ─── state.value ───

  test('state.value is typed union of state names', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ x: 1 }),
      initial: 'a',
      states: {
        a: { on: { go: () => ({ target: 'b' }) } },
        b: { type: 'final' },
      },
    });
    const s = machine.getInitialState();

    s.value satisfies 'a' | 'b';
    // @ts-expect-error — 'c' is not a valid state name
    s.value satisfies 'c';
  });

  // ─── state.context ───

  test('context typed from context() return', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ name: 'test', count: 0, flag: true }),
      initial: 'idle',
      states: { idle: { type: 'final' } },
    });
    const s = machine.getInitialState();

    s.context.name satisfies string;
    s.context.count satisfies number;
    s.context.flag satisfies boolean;
    // @ts-expect-error — name is string not number
    s.context.name satisfies number;
    // @ts-expect-error — 'nope' does not exist
    s.context.nope;
  });

  test('transition context is Partial<TContext> — rejects unknown keys', () => {
    createAgentMachine({
      id: 't',
      schemas: { events: { go: z.object({}) } },
      context: () => ({ count: 0, name: 'hello' }),
      initial: 'idle',
      states: {
        idle: {
          on: {
            go: ({ context }) => ({
              target: 'idle',
              // valid: known key
              context: { count: context.count + 1 },
            }),
          },
        },
      },
    });

    createAgentMachine({
      id: 't2',
      schemas: { events: { go: z.object({}) } },
      context: () => ({ count: 0 }),
      initial: 'idle',
      states: {
        idle: {
          on: {
            // @ts-expect-error — 'foo' not a valid context key
            go: () => ({
              target: 'idle',
              context: { foo: 'bar' },
            }),
          },
        },
      },
    });
  });

  test('context typed in on handlers', () => {
    const machine = createAgentMachine({
      id: 't',
      schemas: { events: { add: z.object({}) } },
      context: () => ({ items: ['a', 'b'] }),
      initial: 'idle',
      states: {
        idle: {
          on: {
            add: ({ context }) => {
              context.items satisfies string[];
              // @ts-expect-error — 'nope' does not exist
              context.nope;
              return { context: { items: [...context.items, 'c'] } };
            },
          },
        },
      },
    });
    const next = machine.transition(machine.getInitialState(), { type: 'add' });
    expect(next.context.items).toEqual(['a', 'b', 'c']);
  });

  test('context typed in invoke', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ n: 42 }),
      initial: 'work',
      states: {
        work: {
          schemas: { output: z.object({ doubled: z.number() }) },
          invoke: async ({ context }) => {
            context.n satisfies number;
            // @ts-expect-error — 'nope' does not exist
            context.nope;
            return { doubled: context.n * 2 };
          },
          onDone: ({ output }) => ({
            target: 'done',
            context: { n: output.doubled },
          }),
        },
        done: { type: 'final' },
      },
    });
    return machine.execute(machine.getInitialState()).then((r) => {
      expect(r.status === 'done' && r.context.n).toBe(84);
    });
  });

  test('context typed in output', () => {
    const machine = createAgentMachine({
      id: 't',
      schemas: {
        output: z.object({
          score: z.number(),
        }),
      },
      context: () => ({ score: 100 }),
      initial: 'done',
      states: {
        done: {
          type: 'final',
          output: ({ context }) => {
            context.score satisfies number;
            // @ts-expect-error — 'nope' does not exist
            context.nope;
            return { score: context.score };
          },
        },
      },
    });
    expect(machine.getInitialState).toBeDefined();
  });

  test('context typed in initial function', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ mode: 'fast' as 'fast' | 'slow' }),
      initial: ({ context }) => {
        context.mode satisfies 'fast' | 'slow';
        // @ts-expect-error — 'nope' does not exist
        context.nope;
        return { target: (context.mode === 'fast' ? 'a' : 'b') as 'a' | 'b' };
      },
      states: {
        a: { type: 'final' },
        b: { type: 'final' },
      },
    });
    expect(machine.getInitialState().value).toBe('a');
  });

  // ─── schemas.context (overload 1) ───

  test('schemas.context drives TContext + input typed from schemas.input', () => {
    const machine = createAgentMachine({
      id: 't',
      schemas: {
        context: z.object({ count: z.number(), label: z.string() }),
        input: z.object({ initial: z.number() }),
      },
      context: (input) => {
        input.initial satisfies number;
        // @ts-expect-error — 'nope' does not exist on input
        input.nope;
        return { count: input.initial, label: 'hello' };
      },
      initial: 'idle',
      states: {
        idle: {
          invoke: async ({ context }) => {
            context.count satisfies number;
            context.label satisfies string;
            // @ts-expect-error — 'nope' does not exist
            context.nope;
            return {};
          },
        },
      },
    });
    const s = machine.getInitialState({ initial: 5 });

    s.context.count satisfies number;
    s.context.label satisfies string;
    // @ts-expect-error — 'nope' does not exist
    s.context.nope;
    expect(s.context.count).toBe(5);
  });

  test('schemas.input alone drives context input typing', () => {
    const machine = createAgentMachine({
      id: 't-input-only',
      schemas: {
        input: z.object({ message: z.string() }),
      },
      context: (input) => {
        input.message satisfies string;
        // @ts-expect-error — 'nope' does not exist on input
        input.nope;
        return { message: input.message, count: 0 };
      },
      initial: 'idle',
      states: {
        idle: {
          type: 'final',
        },
      },
    });

    machine.getInitialState({ message: 'hello' });
    if (false) {
      // @ts-expect-error — message must be string
      machine.getInitialState({ message: 123 });
    }
  });

  // ─── schemas.events ───

  test('transition events typed from schemas.events', () => {
    const machine = createAgentMachine({
      id: 't',
      schemas: {
        events: {
          greet: z.object({ name: z.string() }),
          ping: z.object({}),
        },
      },
      context: () => ({ msg: '' }),
      initial: 'idle',
      states: {
        idle: {
          on: {
            greet: ({ event }) => ({
              context: { msg: `hi ${event.name}` },
            }),
            ping: () => ({}),
          },
        },
      },
    });
    const s = machine.getInitialState();

    // Valid events compile
    machine.transition(s, { type: 'greet', name: 'world' });
    machine.transition(s, { type: 'ping' });

    // @ts-expect-error — 'bogus' is not a valid event type
    expect(() => machine.transition(s, { type: 'bogus' })).toThrow();

    // @ts-expect-error — missing required 'name' field
    expect(() => machine.transition(s, { type: 'greet' })).toThrow();

    expect(() =>
      machine.transition(s, {
        type: 'greet',
        // @ts-expect-error — name must be string
        name: 123,
      })
    ).toThrow();

    const next = machine.transition(s, { type: 'greet', name: 'world' });
    expect(next.context.msg).toBe('hi world');
  });

  test('no schemas.events → untyped events (any type string)', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({}),
      initial: 'idle',
      states: {
        idle: { on: { anything: () => ({}) } },
      },
    });
    // Any event type string accepted when no schemas.events
    machine.transition(machine.getInitialState(), { type: 'anything' });
    // Unknown events still throw at runtime (no handler)
    expect(() =>
      machine.transition(machine.getInitialState(), { type: 'nope' })
    ).toThrow();
  });

  // ─── schemas.input per state ───

  test('input typed per state from schemas.input', async () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ result: '' }),
      initial: 'a',
      states: {
        a: {
          schemas: { input: z.object({ count: z.number() }), output: z.object({ doubled: z.number() }) },
          invoke: async ({ input }) => {
            input.count satisfies number;
            // @ts-expect-error — count is number not string
            input.count satisfies string;
            // @ts-expect-error — 'name' not on a's input
            input.name;
            return { doubled: input.count * 2 };
          },
          onDone: ({ output }) => ({
            target: 'b',
            input: { name: 'hello' },
            context: { result: String(output.doubled) },
          }),
        },
        b: {
          schemas: { input: z.object({ name: z.string() }), output: z.object({ greeting: z.string() }) },
          invoke: async ({ input }) => {
            input.name satisfies string;
            // @ts-expect-error — name is string not number
            input.name satisfies number;
            // @ts-expect-error — 'count' not on b's input
            input.count;
            return { greeting: `hi ${input.name}` };
          },
          onDone: ({ output }) => ({
            target: 'done',
            context: { result: output.greeting },
          }),
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ result: context.result }),
        },
      },
    });

    let state = machine.resolveState({
      ...machine.getInitialState(),
      input: { a: { count: 21 } },
    });
    const r = await machine.execute(state);
    expect(r.status === 'done' && r.output).toEqual({ result: 'hi hello' });
  });

  test('no schemas.input → input is Record<string, unknown>', () => {
    createAgentMachine({
      id: 't',
      context: () => ({}),
      initial: 'idle',
      states: {
        idle: {
          invoke: async ({ input }) => {
            input satisfies Record<string, unknown>;
            return {};
          },
        },
      },
    });
  });

  test('state resolver snapshot is typed from context and input', () => {
    createAgentMachine({
      id: 't',
      schemas: {
        input: z.object({ task: z.string() }),
      },
      context: (input) => ({ task: input.task, count: 1 }),
      initial: 'working',
      states: {
        working: {
          schemas: { input: z.object({ attempt: z.number() }) },
          prompt: ({ snapshot, context, input }) => {
            snapshot.value satisfies string;
            snapshot.context.task satisfies string;
            context.count satisfies number;
            input.attempt satisfies number;
            // @ts-expect-error — resolved prompt is not present while resolving
            snapshot.prompt;
            // @ts-expect-error — attempt is number not string
            input.attempt satisfies string;
            return `${snapshot.value}: ${context.task}`;
          },
          on: {
            done: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });
  });

  // ─── decide helper context typing ───

  test('decide helper gets typed context in invoke and onDone', () => {
    const adapter = mockAdapter([{ choice: 'a' }]);
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ topic: 'cats', result: '' }),
      initial: 'choosing',
      states: {
        choosing: {
          schemas: { output: choiceResultSchema },
          invoke: async ({ context }) => {
            context.topic satisfies string;
            // @ts-expect-error — 'nope' does not exist
            context.nope;
            return decide({
              adapter,
              model: 'test',
              prompt: `About ${context.topic}`,
              options: { a: { description: 'A' } },
            });
          },
          onDone: ({ output, context }) => {
            output.choice satisfies string;
            // @ts-expect-error
            output.nope;
            context.topic satisfies string;
            return { target: 'done', context: { result: output.choice } };
          },
        },
        done: { type: 'final' },
      },
    });
    expect(machine.id).toBe('t');
  });

  // ─── getInitialState input typing ───

  test('getInitialState requires input when schemas.input provided', () => {
    const machine = createAgentMachine({
      id: 't',
      schemas: {
        context: z.object({ task: z.string() }),
        input: z.object({ task: z.string() }),
      },
      context: (input) => ({ task: input.task }),
      initial: 'idle',
      states: { idle: { type: 'final' } },
    });

    // Valid
    machine.getInitialState({ task: 'hello' });

    expect(() =>
      machine.getInitialState({
        // @ts-expect-error — task must be string
        task: 123,
      })
    ).toThrow();

    // @ts-expect-error — missing required input (runtime: validates)
    expect(() => machine.getInitialState()).toThrow();
  });

  test('getInitialState optional when no input schema', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ x: 1 }),
      initial: 'idle',
      states: { idle: { type: 'final' } },
    });

    // Both valid
    machine.getInitialState();
    machine.getInitialState(undefined);
  });

  // ─── schemas.output ───

  test('schemas.output types invoke return and onDone output', () => {
    createAgentMachine({
      id: 't',
      context: () => ({ total: 0 }),
      initial: 'work',
      states: {
        work: {
          schemas: { output: z.object({ value: z.number() }) },
          invoke: async () => {
            // return type must match schemas.output
            return { value: 42 };
          },
          onDone: ({ output }) => {
            // output is typed from schemas.output
            output.value satisfies number;
            // @ts-expect-error — 'nope' does not exist on result
            output.nope;
            return { target: 'done', context: { total: output.value } };
          },
        },
        done: { type: 'final' },
      },
    });
  });

  test('no schemas.output → onDone output is inferred from invoke', () => {
    createAgentMachine({
      id: 't',
      context: () => ({}),
      initial: 'work',
      states: {
        work: {
          invoke: async () => ({ anything: true }),
          onDone: ({ output }) => {
            output.anything satisfies boolean;
            // @ts-expect-error — 'choice' does not exist on invoke result
            output.choice;
            return { target: 'done' };
          },
        },
        done: { type: 'final' },
      },
    });
  });

  test('final output is inferred through execute and snapshots', async () => {
    const machine = createAgentMachine({
      id: 'typed-output',
      schemas: {
        output: z.object({
          count: z.number(),
          label: z.string(),
        }),
      },
      context: () => ({ count: 2 }),
      initial: 'done',
      states: {
        done: {
          type: 'final',
          output: ({ context }) => ({
            count: context.count,
            label: `count:${context.count}`,
          }),
        },
      },
    });

    const runResult = await machine.execute(machine.getInitialState());
    if (runResult.status === 'done') {
      runResult.output.count satisfies number;
      runResult.output.label satisfies string;
      // @ts-expect-error output property should be typed
      runResult.output.missing;
    }

    const snapshot = machine.resolveState(machine.getInitialState());
    snapshot.output satisfies
      | {
          count: number;
          label: string;
        }
      | undefined;
  });

  // ─── events typed in on handlers ───

  test('on handler event typed from schemas.events', () => {
    createAgentMachine({
      id: 't',
      schemas: {
        events: {
          'msg': z.object({ text: z.string() }),
        },
      },
      context: () => ({ last: '' }),
      initial: 'idle',
      states: {
        idle: {
          on: {
            msg: ({ event }) => {
              // event.text is typed from schemas.events
              event.text satisfies string;
              event.type satisfies 'msg';
              return { context: { last: event.text } };
            },
          },
        },
      },
    });
  });

  // ─── static transition shorthand ───

  test('on handler accepts string shorthand', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({}),
      initial: 'a',
      states: {
        a: {
          on: {
            go: { target: 'b' },
          },
        },
        b: { type: 'final' },
      },
    });
    const s = machine.transition(machine.getInitialState(), { type: 'go' });
    expect(s.value).toBe('b');
  });

  test('on handler accepts static TransitionResult object', () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ x: 0 }),
      initial: 'a',
      states: {
        a: {
          on: {
            go: { target: 'b', context: { x: 1 } },
          },
        },
        b: { type: 'final' },
      },
    });
    const s = machine.transition(machine.getInitialState(), { type: 'go' });
    expect(s.value).toBe('b');
    expect(s.context.x).toBe(1);
  });
});

describe('edge cases', () => {
  test('invoke with no onDone is dead end', async () => {
    const machine = createAgentMachine({
      id: 'dead',
      context: () => ({}),
      initial: 'stuck',
      states: { stuck: { invoke: async () => ({}) } },
    });
    const s = await machine.invoke(machine.getInitialState());
    expect(s.value).toBe('stuck');
  });

  test('done state returns as-is', async () => {
    const machine = createSimpleMachine();
    const done = {
      value: 'done' as const,
      input: {},
      context: { count: 1 },
      messages: [],
      status: 'done' as const,
      output: { result: 1 },
    };
    expect(await machine.invoke(done)).toEqual(done);
  });
});

describe('createAdapter', () => {
  test('creates custom adapter', () => {
    const a = createAdapter({
      generateText: async () => 'ok',
    });
    expect(a.generateText).toBeDefined();
    expect('decide' in a).toBe(false);
  });
});
