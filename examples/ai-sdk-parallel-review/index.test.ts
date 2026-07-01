import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createActor, toPromise, type AnyActorLogic } from 'xstate';
import {
  aiSdkParallelReviewMachine,
  summarizeCodeReviews,
} from './index.js';

test('AI SDK parallel review maps to an explicit machine', async () => {
  const actor = createActor(
    aiSdkParallelReviewMachine.provide({
      actorSources: {
        summarizeCodeReviews: summarizeCodeReviews.withExecutor(async ({ input }) =>
          input.reviews.map((review) => review.type).join(','),
        ),
      },
    }) as unknown as AnyActorLogic,
    { input: { code: 'const x = eval(input);' } },
  );
  actor.start();
  await toPromise(actor);
  assert.equal(
    actor.getSnapshot().output.summary,
    'security,performance,maintainability',
  );
});
