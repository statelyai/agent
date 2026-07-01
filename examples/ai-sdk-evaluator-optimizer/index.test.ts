import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createActor, toPromise, type AnyActorLogic } from 'xstate';
import {
  aiSdkEvaluatorOptimizerMachine,
  evaluateTranslation,
  improveTranslation,
  translateText,
} from './index.js';

test('AI SDK evaluator-optimizer maps to an explicit machine', async () => {
  let evaluations = 0;
  const actor = createActor(
    aiSdkEvaluatorOptimizerMachine.provide({
      actorSources: {
        translateText: translateText.withExecutor(async ({ input }) =>
          `${input.targetLanguage}:${input.text}`,
        ),
        evaluateTranslation: evaluateTranslation.withExecutor(async () => {
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
        }),
        improveTranslation: improveTranslation.withExecutor(async ({ input }) =>
          `${input.translation} improved`,
        ),
      },
    }) as unknown as AnyActorLogic,
    {
      input: {
        text: 'Hello friend',
        targetLanguage: 'Spanish',
        maxIterations: 3,
      },
    },
  );
  actor.start();
  await toPromise(actor);
  assert.deepEqual(actor.getSnapshot().output, {
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
