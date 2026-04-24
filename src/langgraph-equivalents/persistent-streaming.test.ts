import { expect, test } from 'vitest';
import { runPersistentStreamingExample } from '../../examples/index.js';

test('restores a streaming workflow without replaying stale emitted parts', async () => {
  const result = await runPersistentStreamingExample();

  expect(result.initialParts).toEqual(['hel']);
  expect(result.restoredParts).toEqual(['lo']);
  expect(result.initialSnapshot).toEqual(
    expect.objectContaining({
      value: 'writing',
      status: 'active',
    })
  );
  expect(result.restoredSnapshot).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      output: { text: 'hello' },
    })
  );
  expect(result.journal.map((event) => event.type)).toEqual([
    'xstate.init',
    'xstate.done.invoke.writing',
  ]);
});
