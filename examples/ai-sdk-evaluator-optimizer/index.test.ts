import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import { aiSdkEvaluatorOptimizerMachine } from './index.js';

test('AI SDK evaluator-optimizer maps to an explicit machine', async () => {
  let evaluations = 0;
  const result = await runAgent(aiSdkEvaluatorOptimizerMachine, {
    input: {
      text: 'Hello friend',
      targetLanguage: 'Spanish',
      maxIterations: 3,
    },
    generateText: async (request) => {
      if (request.prompt?.startsWith('Translate this text to Spanish:')) {
        return 'Spanish:Hello friend';
      }
      if (request.prompt?.includes('Suggestions:')) {
        return 'Spanish:Hello friend improved';
      }
      evaluations += 1;
      return evaluations === 1
        ? {
          qualityScore: 6,
          preservesTone: true,
          preservesNuance: false,
          culturallyAccurate: true,
          specificIssues: ['missing nuance'],
          improvementSuggestions: ['add idiom'],
        }
        : {
          qualityScore: 9,
          preservesTone: true,
          preservesNuance: true,
          culturallyAccurate: true,
          specificIssues: [],
          improvementSuggestions: [],
        };
    },
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    translation: 'Spanish:Hello friend improved',
    evaluation: {
      qualityScore: 9,
      preservesTone: true,
      preservesNuance: true,
      culturallyAccurate: true,
      specificIssues: [],
      improvementSuggestions: [],
    },
    iterations: 2,
  });
});
