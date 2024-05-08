import { EventObject, InspectedSnapshotEvent, InspectionEvent } from 'xstate';

export interface AgentHistory {
  snapshotEvents: InspectedSnapshotEvent[];
  add(snapshotEvent: InspectedSnapshotEvent): Promise<void>;
  get(): Promise<InspectedSnapshotEvent[]>;
}

export function createInMemoryHistory(): AgentHistory {
  const snapshotEvents: Array<InspectedSnapshotEvent> = [];

  return {
    snapshotEvents,
    async add(item: InspectedSnapshotEvent) {
      snapshotEvents.push(item);
    },
    async get() {
      return snapshotEvents;
    },
  };
}
