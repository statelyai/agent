import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { createContentCreatorFlowExample } from '../../examples/index.js';

describe('CrewAI content creator flow equivalent', () => {
  test('routes a request and generates specialized content', async () => {
    const machine = createContentCreatorFlowExample({
      routeRequest: async () => ({ route: 'linkedin' }),
      createLinkedInPost: async (request) => ({
        title: 'LinkedIn launch post',
        body: `LinkedIn: ${request}`,
      }),
    });

    const result = await execute(machine, 
      machine.getInitialState({
        request: 'Announce our AI workflow launch in a short professional post.',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        route: 'linkedin',
        title: 'LinkedIn launch post',
        body:
          'LinkedIn: Announce our AI workflow launch in a short professional post.',
      });
    }
  });
});
