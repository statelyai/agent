import { AgentMemory, AgentStorageData, AppendOnlyStorage } from './types';

export function createMemoryStorage(): AgentMemory {
  const storage = {
    sessions: {} as Record<string, AgentStorageData>,
  };

  return {
    append: async (sessionId, key, item) => {
      storage.sessions[sessionId] =
        storage.sessions[sessionId] ||
        ({
          observations: [],
          history: [],
          plans: [],
          feedback: [],
        } satisfies AgentStorageData);

      storage.sessions[sessionId]![key].push(item as any);
    },
    getAll: async (sessionId, key) => {
      return storage.sessions[sessionId]?.[key];
    },
  };
}
