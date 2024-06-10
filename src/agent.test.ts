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
