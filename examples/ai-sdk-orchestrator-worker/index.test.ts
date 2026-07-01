import { test } from 'vitest';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, toPromise, type AnyActorLogic } from 'xstate';
import {
  aiSdkOrchestratorWorkerMachine,
  planImplementation,
} from './index.js';

const fileChangeSchema = z.object({
  filePath: z.string(),
  changeType: z.enum(['create', 'modify', 'delete']),
  explanation: z.string(),
  code: z.string(),
});

test('AI SDK orchestrator-worker maps to an explicit machine', async () => {
  const actor = createActor(
    aiSdkOrchestratorWorkerMachine.provide({
      actorSources: {
        planImplementation: planImplementation.withExecutor(async () => ({
          files: [
            {
              purpose: 'Add UI',
              filePath: 'app/page.tsx',
              changeType: 'modify',
            },
            {
              purpose: 'Add test',
              filePath: 'app/page.test.tsx',
              changeType: 'create',
            },
          ],
          estimatedComplexity: 'medium',
        })),
      },
    }) as unknown as AnyActorLogic,
    { input: { featureRequest: 'Add settings page' } },
  );
  actor.start();
  await toPromise(actor);
  assert.deepEqual(
    actor
      .getSnapshot()
      .output.changes.map((change: z.infer<typeof fileChangeSchema>) =>
        change.filePath,
      ),
    ['app/page.tsx', 'app/page.test.tsx'],
  );
});
