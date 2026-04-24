import {
  createMemoryRunStore,
  restoreSession,
  startSession,
  type PersistedSnapshot,
} from '../src/index.js';
import { createMultiAgentNetworkExample } from './multi-agent-network.js';

type NetworkOptions = Parameters<typeof createMultiAgentNetworkExample>[0];

export function createPersistentMultiAgentNetworkExample(
  options: NetworkOptions = {}
) {
  return createMultiAgentNetworkExample(options);
}

export async function runPersistentMultiAgentNetworkExample(
  input: { topic: string },
  options: NetworkOptions = {}
) {
  const machine = createPersistentMultiAgentNetworkExample(options);
  const baseStore = createMemoryRunStore();
  let persistedHandoffSnapshot = false;

  const store = {
    append: baseStore.append,
    loadEvents: baseStore.loadEvents,
    loadLatestSnapshot: baseStore.loadLatestSnapshot,
    async saveSnapshot(
      snapshot: PersistedSnapshot
    ) {
      const handoffs =
        ((snapshot.snapshot.context as { handoffs?: string[] }).handoffs ?? []);

      if (!persistedHandoffSnapshot && handoffs.length === 1) {
        persistedHandoffSnapshot = true;
        await baseStore.saveSnapshot(snapshot);
        return;
      }

      if (!persistedHandoffSnapshot && handoffs.length === 0) {
        await baseStore.saveSnapshot(snapshot);
      }
    },
  };

  const liveRun = await startSession(machine, {
    store,
    input,
  });

  await waitForTerminal(() => liveRun.getSnapshot().status);

  const restoredRun = await restoreSession(machine, {
    sessionId: liveRun.sessionId,
    store,
  });

  await waitForMatch(
    () => restoredRun.getSnapshot(),
    () => liveRun.getSnapshot()
  );

  return {
    sessionId: liveRun.sessionId,
    liveSnapshot: liveRun.getSnapshot(),
    restoredSnapshot: restoredRun.getSnapshot(),
  };
}

function expectTerminal(status: string) {
  if (status !== 'done' && status !== 'error') {
    throw new Error(`Snapshot is not terminal yet: ${status}`);
  }
}

async function waitForTerminal(
  getStatus: () => string,
  timeoutMs = 1000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      expectTerminal(getStatus());
      return;
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expectTerminal(getStatus());
}

async function waitForMatch<T>(
  getActual: () => T,
  getExpected: () => T,
  timeoutMs = 1000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (JSON.stringify(getActual()) === JSON.stringify(getExpected())) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  if (JSON.stringify(getActual()) !== JSON.stringify(getExpected())) {
    throw new Error('Snapshots did not converge before timeout.');
  }
}
