import { expect, test } from 'vitest';
import { createSupervisorExample } from '../../examples/supervisor.js';

test('supervisor workflow retries a blocked worker and escalates when repeated attempts fail', async () => {
  let decisions = 0;

  const machine = createSupervisorExample({
    adapter: {
      decide: async () => {
        decisions += 1;

        if (decisions === 1) {
          return {
            choice: 'retry',
            data: {
              instruction: 'Retry using the customer email already on file.',
            },
          };
        }

        return {
          choice: 'escalate',
          data: {
            reason: 'Escalate to billing because the request still lacks a verified account match.',
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
  });

  const result = await machine.execute(
    machine.getInitialState({
      request: 'Refund the duplicate annual subscription charge.',
    })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      request: 'Refund the duplicate annual subscription charge.',
      status: 'escalated',
      resolution: null,
      escalationReason:
        'Escalate to billing because the request still lacks a verified account match.',
      attemptCount: 2,
      history: [
        'worker:1:blocked:Missing account identifier.',
        'supervisor:retry:Retry using the customer email already on file.',
        'worker:2:blocked:Still blocked after retry: Retry using the customer email already on file.',
        'supervisor:escalate:Escalate to billing because the request still lacks a verified account match.',
      ],
    });
  }
});
