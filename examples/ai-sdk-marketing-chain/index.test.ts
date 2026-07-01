import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createActor, toPromise, type AnyActorLogic } from 'xstate';
import {
  aiSdkMarketingChainMachine,
  evaluateMarketingCopy,
  improveMarketingCopy,
  writeMarketingCopy,
} from './index.js';

test('AI SDK marketing chain maps to an explicit machine', async () => {
  const actor = createActor(
    aiSdkMarketingChainMachine.provide({
      actorSources: {
        writeMarketingCopy: writeMarketingCopy.withExecutor(async ({ input }) =>
          `Buy ${input.product}`,
        ),
        evaluateMarketingCopy: evaluateMarketingCopy.withExecutor(async () => ({
          hasCallToAction: false,
          emotionalAppeal: 5,
          clarity: 6,
        })),
        improveMarketingCopy: improveMarketingCopy.withExecutor(async ({ input }) =>
          `${input.copy}. Start today.`,
        ),
      },
    }) as unknown as AnyActorLogic,
    { input: { product: 'state machines' } },
  );
  actor.start();
  await toPromise(actor);
  assert.equal(actor.getSnapshot().output.copy, 'Buy state machines. Start today.');
});
