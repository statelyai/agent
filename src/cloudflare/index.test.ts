import { describe, expect, test } from 'vitest';
import {
  createCloudflareAgentRunStore,
  createDurableObjectRunStore,
  type CloudflareAgentRunStoreState,
} from './index.js';

describe('cloudflare adapter', () => {
  test('creates a Durable Object RunStore', async () => {
    const storage = new Map<string, unknown>();
    const store = createDurableObjectRunStore({
      async get(key) {
        return storage.get(key) as never;
      },
      async put(key, value) {
        storage.set(key, value);
      },
    });

    await store.append('session-1', { type: 'start', at: 1 });
    await store.saveSnapshot({
      sessionId: 'session-1',
      afterSequence: 1,
      createdAt: 2,
      snapshot: {
        sessionId: 'session-1',
        createdAt: 2,
        value: 'done',
        status: 'done',
        context: {},
        input: {},
      },
    });

    await expect(store.loadEvents('session-1')).resolves.toEqual([
      {
        type: 'start',
        at: 1,
        sequence: 1,
      },
    ]);
    await expect(store.loadLatestSnapshot('session-1')).resolves.toEqual(
      expect.objectContaining({
        afterSequence: 1,
      })
    );
  });

  test('creates a Cloudflare Agents state-backed RunStore', async () => {
    let state: CloudflareAgentRunStoreState = {
      sessions: {},
    };
    const store = createCloudflareAgentRunStore({
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
    });

    await store.append('session-1', { type: 'approve', at: 1 });
    await store.saveSnapshot({
      sessionId: 'session-1',
      afterSequence: 1,
      createdAt: 2,
      snapshot: {
        sessionId: 'session-1',
        createdAt: 2,
        value: 'done',
        status: 'done',
        context: {},
        input: {},
      },
    });

    await expect(store.loadEvents('session-1')).resolves.toEqual([
      {
        type: 'approve',
        at: 1,
        sequence: 1,
      },
    ]);
    await expect(store.loadLatestSnapshot('session-1')).resolves.toEqual(
      expect.objectContaining({
        afterSequence: 1,
      })
    );
  });
});
