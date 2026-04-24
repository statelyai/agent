import {
  createMemoryRunStore,
  restoreSession,
  startSession,
  type PersistedSnapshot,
} from '../src/index.js';
import { createSupervisorExample } from './supervisor.js';

type SupervisorOptions = Parameters<typeof createSupervisorExample>[0];

export function createPersistentSupervisorExample(
  options: SupervisorOptions = {}
) {
  return createSupervisorExample(options);
}

export async function runPersistentSupervisorExample(
  input: { request: string },
  options: SupervisorOptions = {}
) {
  const machine = createPersistentSupervisorExample(options);
  const baseStore = createMemoryRunStore();
  let persistedRetryHandoff = false;

  const store = {
    append: baseStore.append,
    loadEvents: baseStore.loadEvents,
    loadLatestSnapshot: baseStore.loadLatestSnapshot,
    async saveSnapshot(snapshot: PersistedSnapshot) {
      const context = snapshot.snapshot.context as {
        attemptCount?: number;
        history?: string[];
      };
      const history = context.history ?? [];

      if (
        !persistedRetryHandoff
        && snapshot.snapshot.value === 'handling'
        && context.attemptCount === 1
        && history.some((entry) => entry.startsWith('supervisor:retry:'))
      ) {
        persistedRetryHandoff = true;
        await baseStore.saveSnapshot(snapshot);
        return;
      }

      if (!persistedRetryHandoff) {
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
