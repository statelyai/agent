type Handler = (event: unknown) => void;

export interface RunEmitter {
  emit(type: string, event: unknown): void;
  on(type: string, handler: Handler): () => void;
}

export function createRunEmitter(): RunEmitter {
  const listeners = new Map<string, Set<Handler>>();
  const history = new Map<string, unknown[]>();

  return {
    emit(type, event) {
      const events = history.get(type) ?? [];
      events.push(event);
      history.set(type, events);

      for (const handler of listeners.get(type) ?? []) {
        handler(event);
      }
    },

    on(type, handler) {
      const current = listeners.get(type) ?? new Set<Handler>();
      current.add(handler);
      listeners.set(type, current);

      for (const event of history.get(type) ?? []) {
        handler(event);
      }

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
