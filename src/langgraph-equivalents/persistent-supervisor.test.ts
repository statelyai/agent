import { expect, test } from 'vitest';
import { runPersistentSupervisorExample } from '../../examples/index.js';

test('restores a supervisor handoff workflow from a persisted retry snapshot', async () => {
  let decisions = 0;

  const result = await runPersistentSupervisorExample(
    { request: 'Reverse the duplicate subscription charge.' },
    {
      adapter: {
        decide: async () => {
          decisions += 1;

          if (decisions === 1) {
            return {
              choice: 'retry',
              data: {
                instruction: 'Retry using the verified billing email on file.',
              },
            };
          }

          return {
            choice: 'escalate',
            data: {
              reason: 'Escalate to billing because the account is still ambiguous.',
            },
          };
        },
      },
      handle: async ({ attempt, instruction }) => ({
        status: 'blocked',
        issue:
          attempt === 1
            ? 'Missing account identifier.'
            : `Still blocked after retry: ${instruction}`,
      }),
      maxAttempts: 2,
    }
  );

  expect(result.restoredSnapshot).toEqual(result.liveSnapshot);
  expect(result.restoredSnapshot).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      output: {
        request: 'Reverse the duplicate subscription charge.',
        status: 'escalated',
        resolution: null,
        escalationReason:
          'Escalate to billing because the account is still ambiguous.',
        attemptCount: 2,
        history: [
          'worker:1:blocked:Missing account identifier.',
          'supervisor:retry:Retry using the verified billing email on file.',
          'worker:2:blocked:Still blocked after retry: Retry using the verified billing email on file.',
          'supervisor:escalate:Escalate to billing because the account is still ambiguous.',
        ],
      },
    })
  );
});
