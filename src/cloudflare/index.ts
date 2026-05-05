import type {
  AgentSnapshot,
  JournalEvent,
  JournalEventRecord,
  PersistedSnapshot,
  RunStore,
} from '../types.js';

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

type SessionEntry = {
  events: JournalEventRecord[];
  snapshot: PersistedSnapshot | null;
};

export type CloudflareAgentRunStoreState = {
  sessions: Record<string, SessionEntry>;
};

export function createCloudflareAgentRunStore(options: {
  getState: () => CloudflareAgentRunStoreState;
  setState: (
    nextState: CloudflareAgentRunStoreState
  ) => void | Promise<void>;
}): RunStore {
  return {
    async append(sessionId, event) {
      const currentState = options.getState();
      const currentSession = currentState.sessions[sessionId] ?? {
        events: [],
        snapshot: null,
      };
      const sequence = currentSession.events.length + 1;
      const nextSession: SessionEntry = {
        ...currentSession,
        events: [...currentSession.events, { ...event, sequence }],
      };

      await options.setState({
        ...currentState,
        sessions: {
          ...currentState.sessions,
          [sessionId]: nextSession,
        },
      });

      return { sequence };
    },

    async loadEvents(sessionId, afterSequence = 0) {
      return (
        options.getState().sessions[sessionId]?.events.filter(
          (event) => event.sequence > afterSequence
        ) ?? []
      );
    },

    async loadLatestSnapshot(sessionId) {
      return options.getState().sessions[sessionId]?.snapshot ?? null;
    },

    async saveSnapshot(snapshot) {
      const currentState = options.getState();
      const currentSession = currentState.sessions[snapshot.sessionId] ?? {
        events: [],
        snapshot: null,
      };

      await options.setState({
        ...currentState,
        sessions: {
          ...currentState.sessions,
          [snapshot.sessionId]: {
            ...currentSession,
            snapshot,
          },
        },
      });
    },
  };
}

function journalKey(sessionId: string): string {
  return `sessions/${sessionId}/journal`;
}

function snapshotsKey(sessionId: string): string {
  return `sessions/${sessionId}/snapshots`;
}
