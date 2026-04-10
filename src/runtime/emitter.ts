type Handler = (event: unknown) => void;

export interface RunEmitter {
  emit(type: string, event: unknown): void;
  on(type: string, handler: Handler): () => void;
}

export function createRunEmitter(): RunEmitter {
  const listeners = new Map<string, Set<Handler>>();

  return {
    emit(type, event) {
      for (const handler of listeners.get(type) ?? []) {
        handler(event);
      }
    },

    on(type, handler) {
      const current = listeners.get(type) ?? new Set<Handler>();
      current.add(handler);
      listeners.set(type, current);

      return () => {
        const active = listeners.get(type);
        if (!active) {
          return;
        }

        active.delete(handler);
        if (active.size === 0) {
          listeners.delete(type);
        }
      };
    },
  };
}
