import { test, expect } from 'vitest';
import { createAgent } from './agent';

test('an agent has the expected interface', () => {
  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  expect(agent.decide).toBeDefined();
  expect(agent.generateText).toBeDefined();
  expect(agent.streamText).toBeDefined();

  expect(agent.addFeedback).toBeDefined();
  expect(agent.addHistory).toBeDefined();
  expect(agent.addObservation).toBeDefined();
  expect(agent.addPlan).toBeDefined();
});

test('agent.addHistory() adds to history', () => {
  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  agent.addHistory({
    content: 'msg 1',
    role: 'user',
  });

  agent.addHistory({
    content: 'response 1',
    role: 'assistant',
  });

  expect(agent.select((c) => c.history)).toContainEqual(
    expect.objectContaining({
      content: 'msg 1',
    })
  );

  expect(agent.select((c) => c.history)).toContainEqual(
    expect.objectContaining({
      content: 'response 1',
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

  agent.addFeedback({
    attributes: {
      score: -1,
    },
    goal: 'Win the game',
    observationId: 'obs-1',
  });

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
});

test('agent.addObservation() adds to observations', () => {
  const agent = createAgent({
    name: 'test',
    events: {},
    model: {} as any,
  });

  agent.addObservation({
    state: { value: 'playing', context: {} },
    event: { type: 'play', position: 3 },
    nextState: { value: 'lost', context: {} },
  });

  expect(agent.select((c) => c.observations)).toContainEqual(
    expect.objectContaining({
      state: { value: 'playing', context: {} },
      event: { type: 'play', position: 3 },
      nextState: { value: 'lost', context: {} },
      sessionId: expect.any(String),
      timestamp: expect.any(Number),
    })
  );
});
