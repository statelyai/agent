import type { AgentSnapshot } from '../types.js';
import type { JournalEvent } from './events.js';
import type { PersistedSnapshot, RunStore } from './store.js';

type StoredJournalEvent<TEvent extends JournalEvent> = {
  sequence: number;
  event: TEvent;
};

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
  const journals = new Map<string, Array<StoredJournalEvent<TEvent>>>();
  const snapshots = new Map<string, PersistedSnapshot<TSnapshot>[]>();

  return {
    async append(sessionId, event) {
      const current = journals.get(sessionId) ?? [];
      const sequence = current.length === 0 ? 1 : current[current.length - 1]!.sequence + 1;
      current.push({ sequence, event });
      journals.set(sessionId, current);
    },

    async loadEvents(sessionId, afterSequence = 0) {
      const events = journals.get(sessionId) ?? [];
      return events
        .filter((entry) => entry.sequence > afterSequence)
        .map((entry) => entry.event);
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
