import {
  createPersistenceExample,
} from './persistence.js';
import {
  restoreSession,
  startSession,
  type AgentSnapshot,
  type JournalEvent,
  type JournalEventRecord,
  type PersistedSnapshot,
  type RunStore,
} from '../src/index.js';

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export function createDurableObjectRunStore(
  storage: DurableObjectStorageLike
): RunStore {
  return {
    async append(sessionId, event) {
      const key = journalKey(sessionId);
      const current = (await storage.get<JournalEventRecord[]>(key)) ?? [];
      const sequence =
        current.length === 0
          ? 1
          : current[current.length - 1]!.sequence + 1;

      await storage.put(key, [...current, { ...event, sequence }]);
      return { sequence };
    },

    async loadEvents(sessionId, afterSequence = 0) {
      const current =
        (await storage.get<JournalEventRecord<JournalEvent>[]>(
          journalKey(sessionId)
        )) ?? [];

      return current
        .filter((event) => event.sequence > afterSequence)
        .sort((a, b) => a.sequence - b.sequence);
    },

    async loadLatestSnapshot(sessionId) {
      const snapshots =
        (await storage.get<PersistedSnapshot<AgentSnapshot>[]>(
          snapshotsKey(sessionId)
        )) ?? [];

      return (
        [...snapshots].sort(
          (a, b) =>
            a.afterSequence - b.afterSequence || a.createdAt - b.createdAt
        ).at(-1) ?? null
      );
    },

    async saveSnapshot(snapshot) {
      const key = snapshotsKey(snapshot.sessionId);
      const current =
        (await storage.get<PersistedSnapshot<AgentSnapshot>[]>(key)) ?? [];

      await storage.put(key, [...current, snapshot]);
    },
  };
}

export class AgentSessionDurableObject {
  private readonly store: RunStore;

  constructor(private readonly state: DurableObjectStateLike) {
    this.store = createDurableObjectRunStore(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const machine = createPersistenceExample(async ({ request, approved }) => ({
      summary: `${request} :: approved=${String(approved)}`,
    }));

    if (request.method === 'POST' && url.pathname === '/start') {
      const body = await request.json() as { request: string };
      const run = await startSession(machine, {
        store: this.store,
        input: { request: body.request },
      });

      return Response.json({
        sessionId: run.sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/approve') {
      const sessionId = requiredSessionId(url);
      const run = await restoreSession(machine, {
        store: this.store,
        sessionId,
      });

      await run.send({ type: 'approve' });

      return Response.json({
        sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      const sessionId = requiredSessionId(url);
      const run = await restoreSession(machine, {
        store: this.store,
        sessionId,
      });

      return Response.json({
        sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

function requiredSessionId(url: URL): string {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    throw new Error('Missing sessionId');
  }

  return sessionId;
}

function journalKey(sessionId: string): string {
  return `sessions/${sessionId}/journal`;
}

function snapshotsKey(sessionId: string): string {
  return `sessions/${sessionId}/snapshots`;
}
