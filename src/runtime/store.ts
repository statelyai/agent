import type { AgentSnapshot } from '../types.js';
import type { JournalEvent } from './events.js';

export interface PersistedSnapshot<
  TSnapshot extends AgentSnapshot = AgentSnapshot,
> {
  sessionId: string;
  sequence: number;
  snapshot: TSnapshot;
  lastJournalIndex: number;
  createdAt: number;
}

export interface RunStore<
  TSnapshot extends AgentSnapshot = AgentSnapshot,
  TEvent extends JournalEvent = JournalEvent,
> {
  append(sessionId: string, event: TEvent): Promise<void>;
  loadEvents(sessionId: string, afterSequence?: number): Promise<TEvent[]>;
  loadLatestSnapshot(sessionId: string): Promise<PersistedSnapshot<TSnapshot> | null>;
  saveSnapshot(snapshot: PersistedSnapshot<TSnapshot>): Promise<void>;
}
