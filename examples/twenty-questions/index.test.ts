import { describe, expect, test } from 'vitest';
import { runAgent } from '../../src/index.js';
import type { AgentDecisionRequest, ChosenEvent } from '../../src/index.js';
import { twentyQuestionsMachine } from './index.js';

describe('twenty-questions', () => {
  test('decision loop + idle-first HITL: two questions, then a guess, completes with typed output', async () => {
    let askCount = 0;
    const decide = async (
      request: AgentDecisionRequest
    ): Promise<{ event: ChosenEvent }> => {
      askCount += 1;
      if (askCount <= 2) {
        return { event: { type: 'ASK', question: `Is it question ${askCount}?` } };
      }
      return { event: { type: 'GUESS', answer: 'a cat' } };
    };

    let result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      generateText: async () => ({}),
      decide,
    });

    // First ASK -> idle waiting for the human's answer.
    expect(result.status).toBe('idle');
    if (result.status !== 'idle') throw new Error('expected idle');
    expect(result.snapshot.value).toBe('awaitingAnswer');

    result = await runAgent(twentyQuestionsMachine, {
      snapshot: result.snapshot,
      event: { type: 'ANSWER_NO' },
      generateText: async () => ({}),
      decide,
    });

    // Second ASK -> idle again.
    expect(result.status).toBe('idle');
    if (result.status !== 'idle') throw new Error('expected idle');
    expect(result.snapshot.value).toBe('awaitingAnswer');

    result = await runAgent(twentyQuestionsMachine, {
      snapshot: result.snapshot,
      event: { type: 'ANSWER_YES' },
      generateText: async () => ({}),
      decide,
    });

    // GUESS -> done.
    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.output).toEqual({ guess: 'a cat', questionsUsed: 2 });
  });

  test('guard rejects ASK at 0 questions remaining; resolveDecision retries through runAgent', async () => {
    let callCount = 0;
    const requestsSeen: AgentDecisionRequest[] = [];
    const decide = async (
      request: AgentDecisionRequest
    ): Promise<{ event: ChosenEvent }> => {
      requestsSeen.push(request);
      callCount += 1;
      if (callCount === 1) {
        // Type + payload legal, but guard-rejected: no questions remaining.
        return { event: { type: 'ASK', question: 'One more?' } };
      }
      return { event: { type: 'GUESS', answer: 'a dog' } };
    };

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 0 },
      generateText: async () => ({}),
      decide,
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.output).toEqual({ guess: 'a dog', questionsUsed: 0 });
    expect(callCount).toBe(2);
    expect(requestsSeen[1]!.attempts[0]!.failure).toBe('rejected-by-guard');
  });

  test('persistence round-trip: idle snapshot survives JSON.stringify/parse before resuming', async () => {
    const decide = async (): Promise<{ event: ChosenEvent }> => ({
      event: { type: 'ASK', question: 'Is it alive?' },
    });

    const first = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      generateText: async () => ({}),
      decide,
    });

    expect(first.status).toBe('idle');
    if (first.status !== 'idle') throw new Error('expected idle');

    const persisted = JSON.stringify(first.snapshot);
    const restoredSnapshot = JSON.parse(persisted);

    const guessDecide = async (): Promise<{ event: ChosenEvent }> => ({
      event: { type: 'GUESS', answer: 'a fish' },
    });

    const second = await runAgent(twentyQuestionsMachine, {
      snapshot: restoredSnapshot,
      event: { type: 'ANSWER_YES' },
      generateText: async () => ({}),
      decide: guessDecide,
    });

    expect(second.status).toBe('done');
    if (second.status !== 'done') throw new Error('expected done');
    expect(second.output).toEqual({ guess: 'a fish', questionsUsed: 1 });
  });
});
