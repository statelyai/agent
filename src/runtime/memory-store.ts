import type { AgentSnapshot } from '../types.js';
import type { JournalEvent } from './events.js';
import type { PersistedSnapshot, RunStore } from './store.js';

function compareEvents(a: JournalEvent, b: JournalEvent): number {
  return a.sequence - b.sequence || a.at - b.at;
}

function compareSnapshots(
  a: PersistedSnapshot<AgentSnapshot>,
  b: PersistedSnapshot<AgentSnapshot>
): number {
  return a.sequence - b.sequence || a.createdAt - b.createdAt;
}

export function createMemoryRunStore<
  TSnapshot extends AgentSnapshot = AgentSnapshot,
  TEvent extends JournalEvent = JournalEvent,
>(): RunStore<TSnapshot, TEvent> {
  const journals = new Map<string, TEvent[]>();
  const snapshots = new Map<string, PersistedSnapshot<TSnapshot>[]>();

  return {
    async append(sessionId, event) {
      const current = journals.get(sessionId) ?? [];
      current.push(event);
      journals.set(sessionId, current);
    },

    async loadEvents(sessionId) {
      const events = journals.get(sessionId) ?? [];
      return [...events].sort(compareEvents) as TEvent[];
    },

    async loadLatestSnapshot(sessionId) {
      const saved = snapshots.get(sessionId);
      if (!saved?.length) {
        return null;
      }

      const sorted = [...saved].sort(compareSnapshots);
      return sorted[sorted.length - 1] ?? null;
    },

    async saveSnapshot(snapshot) {
      const current = snapshots.get(snapshot.sessionId) ?? [];
      current.push(snapshot);
      snapshots.set(snapshot.sessionId, current);
    },
  };
}
