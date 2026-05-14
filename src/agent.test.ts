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
import type { AgentAdapter } from './types.js';

// ─── Test helpers ───

function mockAdapter(
  responses: Array<{
    choice: string;
    data?: Record<string, unknown>;
    reasoning?: string;
  }>
): AgentAdapter {
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
        resultSchema: z.object({ value: z.number() }),
        invoke: async ({ context }) => {
          // context.count is typed as number ✓
          return { value: context.count + 1 };
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: { count: result.value },
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
        resultSchema: z.object({ output: z.string() }),
        invoke: async ({ context }) => {
          // context.messages is typed ✓
          return {
            output: `Processed: ${context.messages.map((m) => m.content).join(', ')}`,
          };
        },
        onDone: ({ result }) => ({
          target: 'reviewing',
          context: { result: result.output },
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

function createDecideMachine(adapter: AgentAdapter) {
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
        resultSchema: decideResultSchema(options),
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'test-model',
            prompt: `Classify: ${context.issue}`,
            options,
          }),
        onDone: ({ result }) => ({
          target: 'handling',
          context: { category: result.choice },
        }),
      },
      handling: {
        resultSchema: z.object({ resolution: z.string() }),
        invoke: async ({ context }) => ({
          resolution: `Handled ${context.category} issue`,
        }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { resolution: result.resolution },
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

function createClassifyMachine(adapter: AgentAdapter) {
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
        resultSchema: classifyResultSchema(categories),
        invoke: async ({ context }) =>
          classify({
            adapter,
            model: 'test-model',
            prompt: `Classify: "${context.issue}"`,
            into: categories,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { category: result.category },
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
          resultSchema: decideResultSchema({
            a: { description: 'A' },
            b: { description: 'B' },
          }),
          invoke: async ({ context }) =>
            decide({
              adapter: { decide: spy },
              model: 'my-model',
              prompt: `About ${context.topic}`,
              options: { a: { description: 'A' }, b: { description: 'B' } },
            }),
          onDone: ({ result }) => ({
            target: 'done',
            context: { choice: result.choice },
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
          resultSchema: decideResultSchema({
            state: { description: 'State' },
            machine: { description: 'Machine' },
          }),
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
          onDone: ({ result }) => ({
            target: 'done',
            context: { choice: result.choice },
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
          resultSchema: decideResultSchema({
            withData: {
              description: 'Has data',
              schema: z.object({ items: z.array(z.string()) }),
            },
            withoutData: { description: 'No data' },
          }),
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
          onDone: ({ result }) => {
            return {
              target: 'done',
              context: {
                items:
                  result.choice === 'withData'
                    ? (result.data.items ?? null)
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

describe('type: choice', () => {
  test('inline choice state with typed context', async () => {
    const adapter = mockAdapter([{ choice: 'technical' }]);
    const machine = createAgentMachine({
      id: 'choice-test',
      context: () => ({ issue: 'App crashes', result: null as string | null }),
      adapter,
      initial: 'routing',
      states: {
        routing: {
          type: 'choice',
          resultSchema: choiceResultSchema,
          model: 'test-model',
          prompt: ({ context }) => `Route: ${context.issue}`, // context typed ✓
          options: {
            billing: { description: 'Billing' },
            technical: { description: 'Technical' },
          },
          onDone: ({ result, context }) => ({
            target: 'done',
            context: { result: `${result.choice}: ${context.issue}` },
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

  test('choice with event preemption', async () => {
    let called = false;
    const adapter: AgentAdapter = {
      decide: async () => {
        called = true;
        // Slow adapter — in real use, event would preempt
        return { choice: 'a', data: {} };
      },
    };
    const machine = createAgentMachine({
      id: 'choice-preempt',
      context: () => ({}),
      adapter,
      initial: 'choosing',
      states: {
        choosing: {
          type: 'choice',
          resultSchema: choiceResultSchema,
          model: 'test',
          prompt: 'pick',
          options: { a: { description: 'A' } },
          onDone: () => ({ target: 'done' }),
          on: {
            cancel: () => ({ target: 'cancelled' }),
          },
        },
        done: { type: 'final' },
        cancelled: { type: 'final' },
      },
    });

    // Can send event to choice state (preemption)
    const state = machine.getInitialState();
    const next = machine.transition(state, { type: 'cancel' });
    expect(next.value).toBe('cancelled');
  });
});

describe('messages and always', () => {
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
          resultSchema: z.object({ text: z.string() }),
          invoke: async ({ messages }) => ({
            text: `reply to ${messages.at(-1)?.content}`,
          }),
          onDone: ({ result, context, messages }) => ({
            target: 'checking',
            context: { attempts: context.attempts + 1 },
            messages: messages.concat({
              role: 'assistant',
              content: result.text,
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
          resultSchema: z.object({ doubled: z.number() }),
          invoke: async ({ context }) => {
            context.n satisfies number;
            // @ts-expect-error — 'nope' does not exist
            context.nope;
            return { doubled: context.n * 2 };
          },
          onDone: ({ result }) => ({
            target: 'done',
            context: { n: result.doubled },
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

  // ─── inputSchema per state ───

  test('input typed per state from inputSchema', async () => {
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ result: '' }),
      initial: 'a',
      states: {
        a: {
          inputSchema: z.object({ count: z.number() }),
          resultSchema: z.object({ doubled: z.number() }),
          invoke: async ({ input }) => {
            input.count satisfies number;
            // @ts-expect-error — count is number not string
            input.count satisfies string;
            // @ts-expect-error — 'name' not on a's input
            input.name;
            return { doubled: input.count * 2 };
          },
          onDone: ({ result }) => ({
            target: 'b',
            input: { name: 'hello' },
            context: { result: String(result.doubled) },
          }),
        },
        b: {
          inputSchema: z.object({ name: z.string() }),
          resultSchema: z.object({ greeting: z.string() }),
          invoke: async ({ input }) => {
            input.name satisfies string;
            // @ts-expect-error — name is string not number
            input.name satisfies number;
            // @ts-expect-error — 'count' not on b's input
            input.count;
            return { greeting: `hi ${input.name}` };
          },
          onDone: ({ result }) => ({
            target: 'done',
            context: { result: result.greeting },
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

  test('no inputSchema → input is Record<string, unknown>', () => {
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

  // ─── type: 'choice' context typing ───

  test('type: choice gets typed context in prompt and onDone', () => {
    const adapter = mockAdapter([{ choice: 'a' }]);
    const machine = createAgentMachine({
      id: 't',
      context: () => ({ topic: 'cats', result: '' }),
      adapter,
      initial: 'choosing',
      states: {
        choosing: {
          type: 'choice',
          resultSchema: choiceResultSchema,
          model: 'test',
          prompt: ({ context }) => {
            context.topic satisfies string;
            // @ts-expect-error — 'nope' does not exist
            context.nope;
            return `About ${context.topic}`;
          },
          options: { a: { description: 'A' } },
          onDone: ({ result, context }) => {
            result.choice satisfies string;
            // @ts-expect-error
            result.nope;
            context.topic satisfies string;
            return { target: 'done', context: { result: result.choice } };
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

  // ─── resultSchema ───

  test('resultSchema types invoke return and onDone result', () => {
    createAgentMachine({
      id: 't',
      context: () => ({ total: 0 }),
      initial: 'work',
      states: {
        work: {
          resultSchema: z.object({ value: z.number() }),
          invoke: async () => {
            // return type must match resultSchema
            return { value: 42 };
          },
          onDone: ({ result }) => {
            // result is typed from resultSchema
            result.value satisfies number;
            // @ts-expect-error — 'nope' does not exist on result
            result.nope;
            return { target: 'done', context: { total: result.value } };
          },
        },
        done: { type: 'final' },
      },
    });
  });

  test('no resultSchema → onDone result is inferred from invoke', () => {
    createAgentMachine({
      id: 't',
      context: () => ({}),
      initial: 'work',
      states: {
        work: {
          invoke: async () => ({ anything: true }),
          onDone: ({ result }) => {
            result.anything satisfies boolean;
            // @ts-expect-error — 'choice' does not exist on invoke result
            result.choice;
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
      decide: async () => ({ choice: 'a', data: {} }),
    });
    expect(a.decide).toBeDefined();
  });
});
