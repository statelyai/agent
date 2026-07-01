import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createActor, toPromise, type AnyActorLogic } from 'xstate';
import {
  aiSdkRoutingMachine,
  answerCustomerQuery,
  classifyCustomerQuery,
} from './index.js';

test('AI SDK routing maps to an explicit machine', async () => {
  const routedModels: string[] = [];
  const actor = createActor(
    aiSdkRoutingMachine.provide({
      actorSources: {
        classifyCustomerQuery: classifyCustomerQuery.withExecutor(async () => ({
          reasoning: 'needs troubleshooting',
          type: 'technical',
          complexity: 'complex',
        })),
        answerCustomerQuery: answerCustomerQuery.withExecutor(
          async ({ input, request }) => {
            routedModels.push(request.model);
            return `${input.classification.type}:${input.query}`;
          },
        ),
      },
    }) as unknown as AnyActorLogic,
    { input: { query: 'The app crashes on launch.' } },
  );
  actor.start();
  await toPromise(actor);
  assert.deepEqual(routedModels, ['openai/o4-mini']);
  assert.equal(
    actor.getSnapshot().output.response,
    'technical:The app crashes on launch.',
  );
});
