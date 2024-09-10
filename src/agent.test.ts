import { test, expect, vi } from 'vitest';
import {
  AgentGenerateTextResult,
  AgentMessage,
  createAgent,
  type AIAdapter,
} from './';
import { createActor, createMachine } from 'xstate';
import { LanguageModelV1CallOptions } from 'ai';
import { z } from 'zod';
import { dummyResponseValues, MockLanguageModelV1 } from './mockModel';

test('an agent has the expected interface', () => {
  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  expect(agent.decide).toBeDefined();
  // expect(agent.generateText).toBeDefined();
  // expect(agent.streamText).toBeDefined();

  expect(agent.addMessage).toBeDefined();
  expect(agent.addObservation).toBeDefined();
  expect(agent.addFeedback).toBeDefined();
  expect(agent.addPlan).toBeDefined();

  expect(agent.getMessages).toBeDefined();
  expect(agent.getObservations).toBeDefined();
  expect(agent.getFeedback).toBeDefined();
  expect(agent.getPlans).toBeDefined();

  expect(agent.interact).toBeDefined();
});

test('agent.addMessage() adds to message history', () => {
  const model = new MockLanguageModelV1({});

  const agent = createAgent({
    name: 'test',
    events: {},
    model,
  });

  agent.addMessage({
    role: 'user',
    content: [{ type: 'text', text: 'msg 1' }],
  });

  const messageHistory = agent.addMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'response 1' }],
  });

  expect(messageHistory.sessionId).toEqual(agent.sessionId);

  expect(agent.getMessages()).toContainEqual(
    expect.objectContaining({
      content: [expect.objectContaining({ text: 'msg 1' })],
    })
  );

  expect(agent.getMessages()).toContainEqual(
    expect.objectContaining({
      content: [expect.objectContaining({ text: 'response 1' })],
      sessionId: expect.any(String),
      timestamp: expect.any(Number),
    })
  );
});

test('agent.addFeedback() adds to feedback', () => {
  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  const feedback = agent.addFeedback({
    attributes: {
      score: -1,
    },
    goal: 'Win the game',
    observationId: 'obs-1',
  });

  expect(feedback.sessionId).toEqual(agent.sessionId);

  expect(agent.select((c) => c.feedback)).toContainEqual(
    expect.objectContaining({
      attributes: {
        score: -1,
      },
      goal: 'Win the game',
      observationId: 'obs-1',
      sessionId: expect.any(String),
      timestamp: expect.any(Number),
    })
  );
  expect(agent.getFeedback()).toContainEqual(
    expect.objectContaining({
      attributes: {
        score: -1,
      },
      goal: 'Win the game',
      observationId: 'obs-1',
      sessionId: expect.any(String),
      timestamp: expect.any(Number),
    })
  );
});

test('agent.addObservation() adds to observations', () => {
  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  const observation = agent.addObservation({
    prevState: { value: 'playing', context: {} },
    event: { type: 'play', position: 3 },
    state: { value: 'lost', context: {} },
  });

  expect(observation.sessionId).toEqual(agent.sessionId);

  expect(agent.select((c) => c.observations)).toContainEqual(
    expect.objectContaining({
      prevState: { value: 'playing', context: {} },
      event: { type: 'play', position: 3 },
      state: { value: 'lost', context: {} },
      sessionId: expect.any(String),
      timestamp: expect.any(Number),
    })
  );
});

test('agent.addObservation() adds to observations with machine hash', () => {
  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  const machine = createMachine({
    initial: 'playing',
    states: {
      playing: {
        on: {
          play: 'lost',
        },
      },
      lost: {},
    },
  });

  const observation = agent.addObservation({
    prevState: { value: 'playing', context: {} },
    event: { type: 'play', position: 3 },
    state: { value: 'lost', context: {} },
    machine,
  });

  expect(observation.sessionId).toEqual(agent.sessionId);

  expect(agent.select((c) => c.observations)).toContainEqual(
    expect.objectContaining({
      prevState: { value: 'playing', context: {} },
      event: { type: 'play', position: 3 },
      state: { value: 'lost', context: {} },
      machineHash: expect.any(String),
      sessionId: expect.any(String),
      timestamp: expect.any(Number),
    })
  );
});

test('agent.interact() observes machine actors (no 2nd arg)', () => {
  const machine = createMachine({
    initial: 'a',
    states: {
      a: {
        on: { NEXT: 'b' },
      },
      b: {},
    },
  });

  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  const actor = createActor(machine);

  agent.interact(actor);

  actor.start();

  expect(agent.select((c) => c.observations)).toContainEqual(
    expect.objectContaining({
      prevState: undefined,
      state: expect.objectContaining({ value: 'a' }),
    })
  );
  expect(agent.getObservations()).toContainEqual(
    expect.objectContaining({
      prevState: undefined,
      state: expect.objectContaining({ value: 'a' }),
    })
  );

  actor.send({ type: 'NEXT' });

  expect(agent.select((c) => c.observations)).toContainEqual(
    expect.objectContaining({
      prevState: expect.objectContaining({ value: 'a' }),
      event: { type: 'NEXT' },
      state: expect.objectContaining({ value: 'b' }),
    })
  );
});

test('You can listen for feedback events', () => {
  const fn = vi.fn();
  const agent = createAgent({
    name: 'test',
    events: {},
    adapter: {} as any,
    model: {} as any,
  });

  agent.on('feedback', fn);

  agent.addFeedback({
    attributes: {
      score: -1,
    },
    goal: 'Win the game',
    observationId: 'obs-1',
  });

  expect(fn).toHaveBeenCalled();
});

test('You can listen for plan events', async () => {
  const fn = vi.fn();
  const model = new MockLanguageModelV1({
    doGenerate: async (params: LanguageModelV1CallOptions) => {
      const keys =
        params.mode.type === 'regular'
          ? params.mode.tools?.map((t) => t.name)
          : [];

      return {
        ...dummyResponseValues,
        finishReason: 'tool-calls',
        toolCalls: [
          {
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: keys![0],
            args: `{ "type": "${keys?.[0]}" }`,
          },
        ],
      } as any;
    },
  });

  const agent = createAgent({
    name: 'test',
    model,
    events: {
      WIN: z.object({}),
    },
  });

  agent.on('plan', fn);

  await agent.decide({
    goal: 'Win the game',
    state: {
      value: 'playing',
      context: {},
    },
    machine: createMachine({
      initial: 'playing',
      states: {
        playing: {
          on: {
            WIN: {
              target: 'won',
            },
          },
        },
        won: {},
      },
    }),
  });

  expect(fn).toHaveBeenCalledWith(
    expect.objectContaining({
      plan: expect.objectContaining({
        nextEvent: {
          type: 'WIN',
        },
      }),
    })
  );
});

test('agent.types provides context and event types', () => {
  const agent = createAgent({
    model: {} as any,
    events: {
      setScore: z.object({
        score: z.number(),
      }),
    },
    context: {
      score: z.number(),
    },
  });

  agent.types satisfies { context: any; events: any };

  agent.types.context satisfies { score: number };

  // @ts-expect-error
  agent.types.context satisfies { score: string };
});

test.each(['generateText', 'streamText'] as const)(
  'can provide a correlation ID (%s)',
  async (method) => {
    const agent = createAgent({
      model: {} as any,
      events: {},
      adapter: {
        [method]: async (opts: any) => {
          const res = {
            text: 'response',
          };

          opts.onFinish?.(res);

          return res as AgentGenerateTextResult;
        },
      } as any as AIAdapter,
    });

    const promise = new Promise<AgentMessage>((res) => {
      agent.onMessage((msg) => {
        if (msg.role === 'assistant') {
          res(msg);
        }
      });
    });

    await agent[method]({
      prompt: 'hi',
      correlationId: 'c-1',
    });

    const msg = await promise;

    expect(msg.correlationId).toBe('c-1');
    expect(msg.parentCorrelationId).toBe(undefined);
  }
);

test.each(['generateText', 'streamText'] as const)(
  'correlation IDs are automatically generated if not provided (%s)',
  async (method) => {
    const agent = createAgent({
      model: {} as any,
      events: {},
      adapter: {
        [method]: async (opts: any) => {
          const res = {
            text: 'response',
          };

          opts.onFinish?.(res);

          return res as AgentGenerateTextResult;
        },
      } as any as AIAdapter,
    });

    await agent[method]({
      prompt: 'hi',
    });

    const messages = agent.getMessages();

    expect(messages[0]?.correlationId).toEqual(expect.stringMatching(/.+/));
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.correlationId).toEqual(expect.stringMatching(/.+/));
    expect(messages[1]?.role).toBe('assistant');

    expect(messages[0]!.correlationId).toEqual(messages[1]!.correlationId);
  }
);

test.each(['generateText', 'streamText'] as const)(
  'can provide a parent correlation ID (%s)',
  async (method) => {
    const agent = createAgent({
      model: {} as any,
      events: {},
      adapter: {
        [method]: async (opts: any) => {
          const res = {
            text: 'response',
          };

          opts.onFinish?.(res);

          return res as AgentGenerateTextResult;
        },
      } as any as AIAdapter,
    });

    await agent[method]({
      prompt: 'hi',
      correlationId: 'c-1',
      parentCorrelationId: 'c-0',
    });

    const msg = agent.getMessages().find((msg) => msg.role === 'assistant')!;

    expect(msg.correlationId).toBe('c-1');
    expect(msg.parentCorrelationId).toBe('c-0');
  }
);

test.each(['generateText', 'streamText'] as const)(
  'can add feedback to a correlation (%s)',
  async (method) => {
    const agent = createAgent({
      name: 'test',
      model: {} as any,
      events: {},
      adapter: {
        [method]: async (opts: any) => {
          const res = {
            text: 'response',
          };

          opts.onFinish?.(res);

          return res as AgentGenerateTextResult;
        },
      } as any as AIAdapter,
    });

    const res = await agent[method]({
      prompt: 'test',
    });

    agent.addFeedback({
      correlationId: res.correlationId,
      reward: -1,
    });

    const message = agent.getMessages()[0]!;
    const feedback = agent.getFeedback()[0]!;

    expect(message.correlationId).toBeDefined();
    expect(feedback.correlationId).toEqual(message.correlationId);
  }
);
