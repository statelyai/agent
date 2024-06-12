import { AgentMemory, AgentMemoryContext } from './types';

export function createAgentMemory(): AgentMemory {
  const storage = {
    sessions: {} as Record<string, AgentMemoryContext>,
  };

  return {
    append: async (sessionId, key, item) => {
      storage.sessions[sessionId] =
        storage.sessions[sessionId] ||
        ({
          observations: [],
          messages: [],
          plans: [],
          feedback: [],
        } satisfies AgentMemoryContext);

      storage.sessions[sessionId]![key].push(item as any);
    },
    getAll: async (sessionId, key) => {
      return storage.sessions[sessionId]?.[key];
    },
  };
}
