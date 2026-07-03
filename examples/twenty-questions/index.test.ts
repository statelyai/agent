import { describe, expect, test } from 'vitest';
import { runAgent } from '../../src/index.js';
import type {
  AgentDecisionRequest,
  AgentMessage,
  AgentRequestExecutor,
  AgentUserInput,
  ChosenEvent,
} from '../../src/index.js';
import { twentyQuestionsMachine } from './index.js';

function textContent(message: AgentMessage | undefined) {
  return typeof message?.content === 'string' ? message.content : '';
}

function rawAnswerFrom(request: Parameters<AgentRequestExecutor>[0]) {
  return textContent(request.messages?.at(-1)).match(/Raw answer: (.*)/)?.[1] ?? '';
}

function createClassifier(seenModels: string[] = []): AgentRequestExecutor {
  return async (request) => {
    seenModels.push(request.model);
    const rawAnswer = rawAnswerFrom(request);
    if (request.system?.includes('guess was correct')) {
      return {
        output: {
          correct: /^(yes|correct|right)$/i.test(rawAnswer),
          reasoning: `classified guess feedback ${rawAnswer}`,
        },
      };
    }
    if (request.system?.includes('play another round')) {
      return {
        output: {
          playAgain: /^yes$/i.test(rawAnswer),
          reasoning: `classified play again ${rawAnswer}`,
        },
      };
    }
    return {
      output: {
        answer: rawAnswer === 'mhm' || rawAnswer === 'for sure' ? 'yes' : 'no',
        reasoning: `classified ${rawAnswer}`,
      },
    };
  };
}

describe('twenty-questions', () => {
  test('press-play flow: machine owns context, user prompts, and event validation', async () => {
    let askCount = 0;
    const decisionModels: string[] = [];
    const textModels: string[] = [];
    const prompts: string[] = [];
    const answers = ['mhm', 'for sure', 'no', 'no'];

    const decide = async (
      request: AgentDecisionRequest
    ): Promise<{ event: ChosenEvent }> => {
      decisionModels.push(request.model);
      askCount += 1;
      if (askCount <= 2) {
        return { event: { type: 'ASK', question: `Is it question ${askCount}?` } };
      }
      return { event: { type: 'GUESS', guess: 'a cat' } };
    };

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      generateText: createClassifier(textModels),
      decide,
      userInput: async (input: AgentUserInput) => {
        prompts.push(input.prompt ?? '');
        return answers.shift() ?? 'no';
      },
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.output).toEqual({
      guess: 'a cat',
      questionsUsed: 2,
      userScore: 1,
      agentScore: 0,
      roundsPlayed: 1,
    });
    expect(prompts).toEqual([
      'Is it question 1?',
      'Is it question 2?',
      'My guess is a cat. Was I right?',
      'Do you want to play another round?',
    ]);
    expect(decisionModels).toEqual(['quick', 'quick', 'quick']);
    expect(textModels).toEqual(['quick', 'quick', 'quick', 'quick']);
  });

  test('guard rejects ASK on the final turn; resolveDecision retries through runAgent', async () => {
    let callCount = 0;
    const requestsSeen: AgentDecisionRequest[] = [];
    const decide = async (
      request: AgentDecisionRequest
    ): Promise<{ event: ChosenEvent }> => {
      requestsSeen.push(request);
      callCount += 1;
      if (callCount === 1) {
        return { event: { type: 'ASK', question: 'One more?' } };
      }
      return { event: { type: 'GUESS', guess: 'a dog' } };
    };

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 1 },
      generateText: createClassifier(),
      decide,
      userInput: async () => 'correct',
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.output).toEqual({
      guess: 'a dog',
      questionsUsed: 0,
      userScore: 0,
      agentScore: 1,
      roundsPlayed: 1,
    });
    expect(callCount).toBe(2);
    expect(requestsSeen[1]!.attempts[0]!.failure).toBe('rejected-by-guard');
  });

  test('can play another round without host-side accepted-event branching', async () => {
    const guesses = ['a fish', 'a piano'];
    const answers = ['correct', 'yes', 'wrong', 'no'];
    const prompts: string[] = [];

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 1 },
      generateText: createClassifier(),
      decide: async () => ({
        event: { type: 'GUESS', guess: guesses.shift() ?? 'unknown' },
      }),
      userInput: async ({ prompt }) => {
        prompts.push(prompt ?? '');
        return answers.shift() ?? 'no';
      },
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.output).toEqual({
      guess: 'a piano',
      questionsUsed: 0,
      userScore: 1,
      agentScore: 1,
      roundsPlayed: 2,
    });
    expect(prompts).toEqual([
      'My guess is a fish. Was I right?',
      'Do you want to play another round?',
      'My guess is a piano. Was I right?',
      'Do you want to play another round?',
    ]);
  });
});
