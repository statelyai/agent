import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createInitialState,
  step,
  run,
  stream,
  sendEvent,
  decide,
  classify,
  createAdapter,
} from './index.js';
import type { AgentAdapter } from './types.js';

// ─── Test helpers ───

function mockAdapter(
  responses: Array<{ choice: string; data?: Record<string, unknown>; reasoning?: string }>
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

// ─── Simple machine for basic tests ───

function createSimpleMachine() {
  return createAgentMachine({
    id: 'simple',
    context: () => ({ count: 0 }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          start: () => ({ target: 'running' }),
        },
      },
      running: {
        run: async ({ context }) => {
          return { value: (context.count as number) + 1 };
        },
        onDone: ({ result, context }) => ({
          target: 'done',
          context: { count: (result as any).value },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ result: context.count }),
      },
    },
  });
}

// ─── Machine with events for HITL ───

function createHitlMachine() {
  return createAgentMachine({
    id: 'hitl',
    inputSchema: z.object({ task: z.string() }),
    context: (input) => ({
      task: input.task,
      messages: [] as Array<{ role: string; content: string }>,
      result: null as string | null,
    }),
    events: {
      'user.message': z.object({ message: z.string() }),
      'user.approve': z.object({}),
      'user.cancel': z.object({}),
    },
    initial: 'gathering',
    states: {
      gathering: {
        on: {
          'user.message': ({ event, context }) => ({
            context: {
              messages: [
                ...(context.messages as any[]),
                { role: 'user', content: (event as any).message },
              ],
            },
          }),
          'user.approve': ({ context }) => ({
            target: 'processing',
          }),
          'user.cancel': () => ({ target: 'cancelled' }),
        },
      },
      processing: {
        run: async ({ context }) => {
          const msgs = context.messages as Array<{ content: string }>;
          return { output: `Processed: ${msgs.map((m) => m.content).join(', ')}` };
        },
        onDone: ({ result }) => ({
          target: 'reviewing',
          context: { result: (result as any).output },
        }),
      },
      reviewing: {
        on: {
          'user.approve': () => ({ target: 'done' }),
          'user.message': ({ event, context }) => ({
            target: 'processing',
            context: {
              messages: [
                ...(context.messages as any[]),
                { role: 'user', content: (event as any).message },
              ],
            },
          }),
          'user.cancel': () => ({ target: 'cancelled' }),
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

// ─── Machine with decide state ───

function createDecideMachine(adapter: AgentAdapter) {
  return createAgentMachine({
    id: 'decider',
    context: () => ({
      issue: 'App crashes on login',
      category: null as string | null,
    }),
    adapter,
    initial: 'classifying',
    states: {
      classifying: decide({
        model: 'test-model',
        prompt: ({ context }) => `Classify: ${context.issue}`,
        options: {
          billing: { description: 'Billing issues' },
          technical: { description: 'Technical issues' },
          general: { description: 'General inquiries' },
        },
        onDone: ({ result }) => ({
          target: 'handling',
          context: { category: result.choice },
        }),
      }),
      handling: {
        run: async ({ context }) => ({
          resolution: `Handled ${context.category} issue`,
        }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { resolution: (result as any).resolution },
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

// ─── Machine with classify state ───

function createClassifyMachine(adapter: AgentAdapter) {
  return createAgentMachine({
    id: 'classifier',
    context: () => ({ issue: 'I want my money back', category: null as string | null }),
    adapter,
    initial: 'classifyIntent',
    states: {
      classifyIntent: classify({
        model: 'test-model',
        prompt: ({ context }) => `Classify: "${context.issue}"`,
        into: {
          billing: { description: 'Billing, payments, refunds' },
          technical: { description: 'Technical issues, bugs' },
          general: { description: 'General inquiries' },
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: { category: result.category },
        }),
      }),
      done: {
        type: 'final',
        output: ({ context }) => ({ category: context.category }),
      },
    },
  });
}

// ─── Nested/compound state machine ───

function createNestedMachine() {
  return createAgentMachine({
    id: 'nested',
    context: () => ({
      resolution: null as string | null,
      category: 'billing' as string,
    }),
    initial: 'handling',
    states: {
      handling: {
        initial: ({ context }) => {
          if (context.category === 'billing') {
            return { target: 'checkEligibility' };
          }
          return { target: 'diagnose' };
        },
        states: {
          checkEligibility: {
            run: async () => ({ eligible: true }),
            onDone: ({ result }) => {
              if ((result as any).eligible) return { target: 'processRefund' };
              return { target: 'deny' };
            },
          },
          processRefund: {
            run: async () => ({}),
            onDone: ({ context }) => ({
              target: 'childDone',
              context: { resolution: 'Refund processed' },
            }),
          },
          deny: {
            run: async () => ({ message: 'Not eligible' }),
            onDone: ({ result }) => ({
              target: 'childDone',
              context: { resolution: (result as any).message },
            }),
          },
          diagnose: {
            run: async () => ({ diagnosis: 'It is a bug' }),
            onDone: ({ result }) => ({
              target: 'childDone',
              context: { resolution: (result as any).diagnosis },
            }),
          },
          childDone: { type: 'final' },
        },
        onDone: () => ({
          target: 'respond',
        }),
        on: {
          'user.cancel': () => ({ target: 'cancelled' }),
        },
      },
      respond: {
        run: async ({ context }) => ({ message: context.resolution }),
        onDone: () => ({ target: 'done' }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ resolution: context.resolution }),
      },
      cancelled: {
        type: 'final',
        output: () => ({ cancelled: true }),
      },
    },
  });
}

// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

describe('createAgentMachine', () => {
  test('creates a machine config', () => {
    const machine = createSimpleMachine();
    expect(machine.id).toBe('simple');
    expect(machine.states).toBeDefined();
    expect(machine.states.idle).toBeDefined();
    expect(machine.states.running).toBeDefined();
    expect(machine.states.done).toBeDefined();
  });
});

describe('createInitialState', () => {
  test('creates initial state with context', async () => {
    const machine = createSimpleMachine();
    const state = await createInitialState(machine, undefined);
    expect(state.value).toBe('idle');
    expect(state.context).toEqual({ count: 0 });
    expect(state.status).toBe('running');
    expect(state.params).toEqual({});
  });

  test('validates input against schema', async () => {
    const machine = createHitlMachine();
    const state = await createInitialState(machine, { task: 'test task' });
    expect(state.context.task).toBe('test task');
    expect(state.value).toBe('gathering');
  });

  test('rejects invalid input', async () => {
    const machine = createHitlMachine();
    await expect(createInitialState(machine, { task: 123 })).rejects.toThrow();
  });

  test('resolves string initial', async () => {
    const machine = createSimpleMachine();
    const state = await createInitialState(machine, undefined);
    expect(state.value).toBe('idle');
  });

  test('resolves function initial', async () => {
    const machine = createAgentMachine({
      id: 'fn-initial',
      context: (input) => ({ mode: input }),
      initial: ({ context }) => ({
        target: context.mode === 'fast' ? 'fast' : 'slow',
      }),
      states: {
        fast: { type: 'final' },
        slow: { type: 'final' },
      },
    });
    const state = await createInitialState(machine, 'fast');
    expect(state.value).toBe('fast');
  });

  test('resolves compound state initial', async () => {
    const machine = createNestedMachine();
    const state = await createInitialState(machine, undefined);
    // Should enter handling → checkEligibility (since category is 'billing')
    expect(state.value).toBe('handling.checkEligibility');
  });
});

describe('step', () => {
  test('executes run and transitions via onDone', async () => {
    const machine = createSimpleMachine();
    let state = await createInitialState(machine, undefined);
    // idle → send start event to get to 'running'
    state = sendEvent(machine, state, { type: 'start' });
    expect(state.value).toBe('running');

    state = await step(machine, state);
    expect(state.value).toBe('done');
    expect(state.context.count).toBe(1);
  });

  test('returns waiting for event-only states', async () => {
    const machine = createHitlMachine();
    let state = await createInitialState(machine, { task: 'test' });
    state = await step(machine, state);
    expect(state.status).toBe('waiting');
    expect(state.value).toBe('gathering');
  });

  test('returns done for final states', async () => {
    const machine = createSimpleMachine();
    let state = await createInitialState(machine, undefined);
    state = sendEvent(machine, state, { type: 'start' });
    state = await step(machine, state); // run → done
    state = await step(machine, state); // final
    expect(state.status).toBe('done');
    expect(state.output).toEqual({ result: 1 });
  });

  test('handles context updates in transitions', async () => {
    const machine = createSimpleMachine();
    let state = await createInitialState(machine, undefined);
    state = sendEvent(machine, state, { type: 'start' });
    state = await step(machine, state);
    expect(state.context.count).toBe(1);
  });

  test('handles decide state with adapter', async () => {
    const adapter = mockAdapter([
      { choice: 'technical', data: {} },
    ]);
    const machine = createDecideMachine(adapter);
    let state = await createInitialState(machine, undefined);
    expect(state.value).toBe('classifying');

    state = await step(machine, state);
    expect(state.value).toBe('handling');
    expect(state.context.category).toBe('technical');
  });

  test('handles classify state', async () => {
    const adapter = mockAdapter([
      { choice: 'billing', data: {} },
    ]);
    const machine = createClassifyMachine(adapter);
    let state = await createInitialState(machine, undefined);

    state = await step(machine, state);
    expect(state.value).toBe('done');
    expect(state.context.category).toBe('billing');
  });

  test('errors without adapter on decide state', async () => {
    const machine = createAgentMachine({
      id: 'no-adapter',
      context: () => ({}),
      initial: 'deciding',
      states: {
        deciding: decide({
          model: 'test',
          prompt: 'test',
          options: { a: { description: 'A' } },
          onDone: () => ({ target: 'done' }),
        }),
        done: { type: 'final' },
      },
    });
    const state = await createInitialState(machine, undefined);
    const result = await step(machine, state);
    expect(result.status).toBe('error');
    expect(result.error).toContain('No adapter');
  });

  test('bubbles error from run', async () => {
    const machine = createAgentMachine({
      id: 'error-machine',
      context: () => ({}),
      initial: 'failing',
      states: {
        failing: {
          run: async () => {
            throw new Error('boom');
          },
          onDone: () => ({ target: 'done' }),
        },
        done: { type: 'final' },
      },
    });
    const state = await createInitialState(machine, undefined);
    const result = await step(machine, state);
    expect(result.status).toBe('error');
    expect((result.error as Error).message).toBe('boom');
  });

  test('handles nested state entry and execution', async () => {
    const machine = createNestedMachine();
    let state = await createInitialState(machine, undefined);
    expect(state.value).toBe('handling.checkEligibility');

    // Step through checkEligibility → processRefund
    state = await step(machine, state);
    expect(state.value).toBe('handling.processRefund');

    // Step through processRefund → childDone
    state = await step(machine, state);
    expect(state.value).toBe('handling.childDone');
    expect(state.context.resolution).toBe('Refund processed');

    // Step: childDone is final → parent onDone → respond
    state = await step(machine, state);
    expect(state.value).toBe('respond');
  });
});

describe('run', () => {
  test('runs until completion', async () => {
    const machine = createSimpleMachine();
    let state = await createInitialState(machine, undefined);
    state = sendEvent(machine, state, { type: 'start' });

    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ result: 1 });
      expect(result.context.count).toBe(1);
    }
  });

  test('stops at waiting state', async () => {
    const machine = createHitlMachine();
    const state = await createInitialState(machine, { task: 'test' });

    const result = await run(machine, state);
    expect(result.status).toBe('waiting');
    if (result.status === 'waiting') {
      expect(result.value).toBe('gathering');
      expect(result.events).toBeDefined();
    }
  });

  test('stops on error', async () => {
    const machine = createAgentMachine({
      id: 'err',
      context: () => ({}),
      initial: 'fail',
      states: {
        fail: {
          run: async () => {
            throw new Error('nope');
          },
          onDone: () => ({ target: 'ok' }),
        },
        ok: { type: 'final' },
      },
    });
    const state = await createInitialState(machine, undefined);
    const result = await run(machine, state);
    expect(result.status).toBe('error');
  });

  test('runs through multiple transitions', async () => {
    const adapter = mockAdapter([{ choice: 'technical' }]);
    const machine = createDecideMachine(adapter);
    const state = await createInitialState(machine, undefined);

    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        category: 'technical',
        resolution: 'Handled technical issue',
      });
    }
  });

  test('runs nested states to completion', async () => {
    const machine = createNestedMachine();
    const state = await createInitialState(machine, undefined);

    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ resolution: 'Refund processed' });
    }
  });

  test('waiting result includes available events', async () => {
    const machine = createHitlMachine();
    const state = await createInitialState(machine, { task: 'test' });

    const result = await run(machine, state);
    expect(result.status).toBe('waiting');
    if (result.status === 'waiting') {
      expect(result.events['user.message']).toBeDefined();
      expect(result.events['user.approve']).toBeDefined();
      expect(result.events['user.cancel']).toBeDefined();
    }
  });
});

describe('sendEvent', () => {
  test('transitions on matching event', async () => {
    const machine = createSimpleMachine();
    const state = await createInitialState(machine, undefined);
    const next = sendEvent(machine, state, { type: 'start' });
    expect(next.value).toBe('running');
    expect(next.status).toBe('running');
  });

  test('handles self-transition (no target)', async () => {
    const machine = createHitlMachine();
    let state = await createInitialState(machine, { task: 'test' });
    state = await step(machine, state); // → waiting

    const next = sendEvent(machine, state, {
      type: 'user.message',
      message: 'hello',
    });
    expect(next.value).toBe('gathering'); // same state
    expect((next.context.messages as any[]).length).toBe(1);
    expect((next.context.messages as any[])[0].content).toBe('hello');
  });

  test('accumulates context on repeated self-transitions', async () => {
    const machine = createHitlMachine();
    let state = await createInitialState(machine, { task: 'test' });
    state = await step(machine, state); // → waiting

    state = sendEvent(machine, state, { type: 'user.message', message: 'one' });
    state = sendEvent(machine, state, { type: 'user.message', message: 'two' });
    state = sendEvent(machine, state, { type: 'user.message', message: 'three' });

    expect((state.context.messages as any[]).length).toBe(3);
  });

  test('transitions to new state with event', async () => {
    const machine = createHitlMachine();
    let state = await createInitialState(machine, { task: 'test' });
    state = await step(machine, state); // → waiting at gathering

    state = sendEvent(machine, state, { type: 'user.approve' });
    expect(state.value).toBe('processing');
    expect(state.status).toBe('running');
  });

  test('throws on unknown event', async () => {
    const machine = createSimpleMachine();
    const state = await createInitialState(machine, undefined);
    expect(() =>
      sendEvent(machine, state, { type: 'nonexistent' })
    ).toThrow("No handler for event 'nonexistent'");
  });

  test('parent event preempts child in nested state', async () => {
    const machine = createNestedMachine();
    let state = await createInitialState(machine, undefined);
    expect(state.value).toBe('handling.checkEligibility');

    // Parent's on handler should preempt
    const next = sendEvent(machine, state, { type: 'user.cancel' });
    expect(next.value).toBe('cancelled');
  });
});

describe('stream', () => {
  test('yields snapshots for each transition', async () => {
    const adapter = mockAdapter([{ choice: 'technical' }]);
    const machine = createDecideMachine(adapter);
    const state = await createInitialState(machine, undefined);

    const snapshots = [];
    for await (const snapshot of stream(machine, state)) {
      snapshots.push(snapshot);
    }

    expect(snapshots.length).toBeGreaterThanOrEqual(3); // initial + classifying→handling + handling→done + done
    expect(snapshots[0]!.value).toBe('classifying');
    const last = snapshots[snapshots.length - 1]!;
    expect(last.status).toBe('done');
  });
});

describe('decide', () => {
  test('creates state config with decide type', () => {
    const config = decide({
      model: 'test',
      prompt: 'test prompt',
      options: {
        a: { description: 'Option A' },
        b: { description: 'Option B' },
      },
      onDone: ({ result }) => ({ target: result.choice }),
    });
    expect(config.__type).toBe('decide');
    expect(config.__decideConfig).toBeDefined();
    expect(config.__decideConfig!.model).toBe('test');
  });

  test('calls adapter with resolved prompt function', async () => {
    const decideSpy = vi.fn().mockResolvedValue({
      choice: 'a',
      data: {},
    });
    const adapter: AgentAdapter = { decide: decideSpy };

    const machine = createAgentMachine({
      id: 'decide-test',
      context: () => ({ topic: 'cats' }),
      adapter,
      initial: 'choosing',
      states: {
        choosing: decide({
          model: 'my-model',
          prompt: ({ context }) => `About ${context.topic}`,
          options: {
            a: { description: 'A' },
            b: { description: 'B' },
          },
          onDone: ({ result }) => ({
            target: 'done',
            context: { choice: result.choice },
          }),
        }),
        done: { type: 'final' },
      },
    });

    const state = await createInitialState(machine, undefined);
    await step(machine, state);

    expect(decideSpy).toHaveBeenCalledWith({
      model: 'my-model',
      prompt: 'About cats',
      options: {
        a: { description: 'A' },
        b: { description: 'B' },
      },
      reasoning: undefined,
    });
  });

  test('supports per-state adapter override', async () => {
    const machineAdapter = mockAdapter([{ choice: 'machine' }]);
    const stateAdapter = mockAdapter([{ choice: 'state' }]);

    const machine = createAgentMachine({
      id: 'override-test',
      context: () => ({ choice: null as string | null }),
      adapter: machineAdapter,
      initial: 'choosing',
      states: {
        choosing: decide({
          model: 'test',
          adapter: stateAdapter, // overrides machine adapter
          prompt: 'pick',
          options: { state: { description: 'S' }, machine: { description: 'M' } },
          onDone: ({ result }) => ({
            target: 'done',
            context: { choice: result.choice },
          }),
        }),
        done: { type: 'final' },
      },
    });

    const state = await createInitialState(machine, undefined);
    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.context.choice).toBe('state'); // used state adapter, not machine
    }
  });

  test('supports reasoning', async () => {
    const adapter: AgentAdapter = {
      decide: async () => ({
        choice: 'a',
        data: {},
        reasoning: 'Because reasons',
      }),
    };

    const machine = createAgentMachine({
      id: 'reasoning-test',
      context: () => ({ reasoning: null as string | null }),
      adapter,
      initial: 'choosing',
      states: {
        choosing: decide({
          model: 'test',
          prompt: 'pick',
          reasoning: true,
          options: { a: { description: 'A' } },
          onDone: ({ result }) => ({
            target: 'done',
            context: { reasoning: result.reasoning ?? null },
          }),
        }),
        done: { type: 'final' },
      },
    });

    const state = await createInitialState(machine, undefined);
    const result = await run(machine, state);
    if (result.status === 'done') {
      expect(result.context.reasoning).toBe('Because reasons');
    }
  });

  test('decide with option schemas passes data', async () => {
    const adapter: AgentAdapter = {
      decide: async () => ({
        choice: 'withData',
        data: { items: ['a', 'b'] },
      }),
    };

    const machine = createAgentMachine({
      id: 'data-test',
      context: () => ({ items: null as string[] | null }),
      adapter,
      initial: 'choosing',
      states: {
        choosing: decide({
          model: 'test',
          prompt: 'pick',
          options: {
            withData: {
              description: 'Has data',
              schema: z.object({ items: z.array(z.string()) }),
            },
            withoutData: { description: 'No data' },
          },
          onDone: ({ result }) => ({
            target: 'done',
            context: {
              items: result.choice === 'withData' ? (result.data as any).items : null,
            },
          }),
        }),
        done: { type: 'final' },
      },
    });

    const state = await createInitialState(machine, undefined);
    const result = await run(machine, state);
    if (result.status === 'done') {
      expect(result.context.items).toEqual(['a', 'b']);
    }
  });
});

describe('classify', () => {
  test('creates state config with classify type', () => {
    const config = classify({
      model: 'test',
      prompt: 'classify this',
      into: {
        a: { description: 'Category A' },
        b: { description: 'Category B' },
      },
      onDone: ({ result }) => ({ target: result.category }),
    });
    expect(config.__type).toBe('classify');
    expect(config.__classifyConfig).toBeDefined();
    expect(config.__decideConfig).toBeDefined(); // classify wraps decide
  });

  test('result has category field', async () => {
    const adapter = mockAdapter([{ choice: 'billing' }]);
    const machine = createClassifyMachine(adapter);
    const state = await createInitialState(machine, undefined);

    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ category: 'billing' });
    }
  });
});

describe('nested states', () => {
  test('enters compound state initial child', async () => {
    const machine = createNestedMachine();
    const state = await createInitialState(machine, undefined);
    expect(state.value).toBe('handling.checkEligibility');
  });

  test('conditional compound initial based on context', async () => {
    const machine = createAgentMachine({
      id: 'cond-nested',
      context: () => ({ category: 'technical' as string }),
      initial: 'handling',
      states: {
        handling: {
          initial: ({ context }) => {
            if (context.category === 'billing') return { target: 'billing' };
            return { target: 'technical' };
          },
          states: {
            billing: {
              run: async () => ({ result: 'billing handled' }),
              onDone: () => ({ target: 'childDone' }),
            },
            technical: {
              run: async () => ({ result: 'tech handled' }),
              onDone: ({ result }) => ({
                target: 'childDone',
                context: { resolution: (result as any).result },
              }),
            },
            childDone: { type: 'final' },
          },
          onDone: () => ({ target: 'done' }),
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ resolution: context.resolution }),
        },
      },
    });

    const state = await createInitialState(machine, undefined);
    expect(state.value).toBe('handling.technical');

    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ resolution: 'tech handled' });
    }
  });

  test('parent onDone fires when child reaches final', async () => {
    const machine = createNestedMachine();
    const state = await createInitialState(machine, undefined);

    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      // The chain: checkEligibility → processRefund → childDone → (parent onDone) → respond → done
      expect(result.output).toEqual({ resolution: 'Refund processed' });
    }
  });

  test('parent event handler preempts children', async () => {
    const machine = createNestedMachine();
    const state = await createInitialState(machine, undefined);
    expect(state.value).toBe('handling.checkEligibility');

    const next = sendEvent(machine, state, { type: 'user.cancel' });
    expect(next.value).toBe('cancelled');
    expect(next.status).toBe('running');

    const result = await run(machine, next);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ cancelled: true });
    }
  });
});

describe('full workflow: HITL', () => {
  test('gather → process → review → done', async () => {
    const machine = createHitlMachine();

    // Start
    let state = await createInitialState(machine, { task: 'build feature' });
    let result = await run(machine, state);
    expect(result.status).toBe('waiting');
    expect(result.status === 'waiting' && result.value).toBe('gathering');

    // Send messages
    state = sendEvent(machine, result.state, { type: 'user.message', message: 'req A' });
    state = sendEvent(machine, state, { type: 'user.message', message: 'req B' });

    // Approve to move to processing
    state = sendEvent(machine, state, { type: 'user.approve' });
    result = await run(machine, state);
    expect(result.status).toBe('waiting');
    expect(result.status === 'waiting' && result.value).toBe('reviewing');
    expect(result.status === 'waiting' && result.context.result).toBe('Processed: req A, req B');

    // Approve the review
    state = sendEvent(machine, result.state, { type: 'user.approve' });
    result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ result: 'Processed: req A, req B' });
    }
  });

  test('gather → process → review → reject → process → review → done', async () => {
    const machine = createHitlMachine();

    let state = await createInitialState(machine, { task: 'write code' });
    let result = await run(machine, state);

    // Send a message
    state = sendEvent(machine, result.state, { type: 'user.message', message: 'initial' });
    state = sendEvent(machine, state, { type: 'user.approve' });
    result = await run(machine, state);
    expect(result.status === 'waiting' && result.value).toBe('reviewing');

    // Reject with feedback (sends us back to processing)
    state = sendEvent(machine, result.state, { type: 'user.message', message: 'fix this' });
    result = await run(machine, state);
    expect(result.status === 'waiting' && result.value).toBe('reviewing');
    expect(result.status === 'waiting' && result.context.result).toBe('Processed: initial, fix this');

    // Approve
    state = sendEvent(machine, result.state, { type: 'user.approve' });
    result = await run(machine, state);
    expect(result.status).toBe('done');
  });

  test('cancel at any point', async () => {
    const machine = createHitlMachine();

    let state = await createInitialState(machine, { task: 'test' });
    let result = await run(machine, state);

    state = sendEvent(machine, result.state, { type: 'user.cancel' });
    result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ cancelled: true });
    }
  });
});

describe('serialization', () => {
  test('state round-trips through JSON', async () => {
    const machine = createHitlMachine();
    let state = await createInitialState(machine, { task: 'test' });
    let result = await run(machine, state);

    // Serialize → deserialize
    const json = JSON.stringify(result.state);
    const restored = JSON.parse(json);

    // Send event on restored state
    const next = sendEvent(machine, restored, {
      type: 'user.message',
      message: 'from restored',
    });
    expect((next.context.messages as any[])[0].content).toBe('from restored');
  });

  test('nested state round-trips through JSON', async () => {
    const machine = createNestedMachine();
    const state = await createInitialState(machine, undefined);

    const json = JSON.stringify(state);
    const restored = JSON.parse(json);

    expect(restored.value).toBe('handling.checkEligibility');

    // Can continue execution from restored state
    const result = await run(machine, restored);
    expect(result.status).toBe('done');
  });
});

describe('createAdapter', () => {
  test('creates a custom adapter', () => {
    const adapter = createAdapter({
      decide: async () => ({ choice: 'a', data: {} }),
    });
    expect(adapter.decide).toBeDefined();
  });
});

describe('edge cases', () => {
  test('state with run but no onDone and no on is a dead end', async () => {
    const machine = createAgentMachine({
      id: 'dead-end',
      context: () => ({}),
      initial: 'stuck',
      states: {
        stuck: {
          run: async () => ({ done: true }),
        },
      },
    });
    const state = await createInitialState(machine, undefined);
    const result = await step(machine, state);
    // run completes but no onDone and no on → state doesn't change
    expect(result.value).toBe('stuck');
  });

  test('already done state returns as-is', async () => {
    const machine = createSimpleMachine();
    const doneState = {
      value: 'done',
      params: {},
      context: { count: 1 },
      status: 'done' as const,
      output: { result: 1 },
    };
    const result = await step(machine, doneState);
    expect(result).toEqual(doneState);
  });

  test('already errored state returns as-is', async () => {
    const machine = createSimpleMachine();
    const errorState = {
      value: 'running',
      params: {},
      context: { count: 0 },
      status: 'error' as const,
      error: 'something went wrong',
    };
    const result = await step(machine, errorState);
    expect(result).toEqual(errorState);
  });
});

describe('P1: nested final state without parent onDone', () => {
  test('does not mark machine as done when parent lacks onDone', async () => {
    // a.b.c where c is final, b has NO onDone, a has onDone
    const machine = createAgentMachine({
      id: 'p1-bug',
      context: () => ({ resolved: false }),
      initial: 'a',
      states: {
        a: {
          initial: 'b',
          states: {
            b: {
              initial: 'c',
              // NO onDone — should halt here, not mark machine done
              states: {
                c: { type: 'final' },
              },
            },
          },
          onDone: () => ({
            target: 'result',
            context: { resolved: true },
          }),
        },
        result: {
          type: 'final',
          output: ({ context }) => ({ resolved: context.resolved }),
        },
      },
    });

    const state = await createInitialState(machine, undefined);
    expect(state.value).toBe('a.b.c');

    // Step: c is final, parent b has no onDone → should wait, NOT done
    const next = await step(machine, state);
    expect(next.status).toBe('waiting');
    expect(next.value).toBe('a.b.c'); // stays put
  });

  test('correctly bubbles when parent has onDone', async () => {
    // Same structure but b HAS onDone → bDone(final) → a.onDone → result
    const machine = createAgentMachine({
      id: 'p1-fixed',
      context: () => ({}),
      initial: 'a',
      states: {
        a: {
          initial: 'b',
          states: {
            b: {
              initial: 'c',
              states: {
                c: { type: 'final' },
              },
              onDone: () => ({ target: 'bDone' }),
            },
            bDone: { type: 'final' },
          },
          onDone: () => ({ target: 'result' }),
        },
        result: {
          type: 'final',
          output: () => ({ ok: true }),
        },
      },
    });

    const state = await createInitialState(machine, undefined);
    const result = await run(machine, state);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ ok: true });
    }
  });

  test('ancestor on handlers still work when halted at final child', async () => {
    const machine = createAgentMachine({
      id: 'p1-escape',
      context: () => ({}),
      initial: 'a',
      states: {
        a: {
          initial: 'b',
          states: {
            b: {
              initial: 'c',
              states: { c: { type: 'final' } },
              // no onDone
            },
          },
          on: {
            escape: () => ({ target: 'escaped' }),
          },
        },
        escaped: {
          type: 'final',
          output: () => ({ escaped: true }),
        },
      },
    });

    const state = await createInitialState(machine, undefined);
    let result = await run(machine, state);
    expect(result.status).toBe('waiting'); // halted at a.b.c

    // Ancestor on handler should still be reachable
    const next = sendEvent(machine, result.state, { type: 'escape' });
    expect(next.value).toBe('escaped');
    result = await run(machine, next);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ escaped: true });
    }
  });
});

describe('P2: event payload validation', () => {
  test('rejects event with invalid payload', async () => {
    const machine = createHitlMachine();
    let state = await createInitialState(machine, { task: 'test' });
    state = await step(machine, state); // → waiting

    // user.message schema requires { message: string }
    // Sending wrong type should throw
    expect(() =>
      sendEvent(machine, state, { type: 'user.message', message: 123 as any })
    ).toThrow();
  });

  test('accepts event with valid payload', async () => {
    const machine = createHitlMachine();
    let state = await createInitialState(machine, { task: 'test' });
    state = await step(machine, state);

    // Should not throw
    const next = sendEvent(machine, state, {
      type: 'user.message',
      message: 'valid string',
    });
    expect((next.context.messages as any[]).length).toBe(1);
  });

  test('skips validation when no schema declared', async () => {
    const machine = createSimpleMachine();
    const state = await createInitialState(machine, undefined);

    // 'start' event has no schema — should not throw
    const next = sendEvent(machine, state, { type: 'start' });
    expect(next.value).toBe('running');
  });

  test('state-level schema overrides root-level', async () => {
    const machine = createAgentMachine({
      id: 'schema-override',
      context: () => ({ val: '' }),
      events: {
        act: z.object({ type: z.literal('act'), val: z.string() }),
      },
      initial: 'a',
      states: {
        a: {
          events: {
            // Override: requires val to be a number
            act: z.object({ type: z.literal('act'), val: z.number() }),
          },
          on: {
            act: ({ event }) => ({
              target: 'b',
              context: { val: String((event as any).val) },
            }),
          },
        },
        b: { type: 'final' },
      },
    });

    const state = await createInitialState(machine, undefined);

    // String val should fail (state schema requires number)
    expect(() =>
      sendEvent(machine, state, { type: 'act', val: 'nope' })
    ).toThrow();

    // Number val should succeed
    const next = sendEvent(machine, state, { type: 'act', val: 42 });
    expect(next.value).toBe('b');
  });
});
