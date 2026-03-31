import type { StateValue } from 'xstate';

export interface StateEntry {
  id: string;
  value: StateValue;
  context: Record<string, unknown>;
  event: { type: string; [key: string]: unknown } | null;
  timestamp: number;
}

export interface Session {
  sessionId: string;
  value: StateValue;
  context: Record<string, unknown>;
  history: StateEntry[];
  createdAt: number;
}

export interface SessionDB {
  createSession(initialContext: Record<string, unknown>): string;
  getSession(sessionId: string): Session | null;
  appendState(
    sessionId: string,
    entry: {
      value: StateValue;
      context: Record<string, unknown>;
      event: { type: string; [key: string]: unknown } | null;
    }
  ): void;
}

// In-memory implementation
const sessions = new Map<string, Session>();

export const db: SessionDB = {
  createSession(initialContext) {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const session: Session = {
      sessionId,
      value: 'checking',
      context: initialContext,
      history: [
        {
          id: crypto.randomUUID(),
          value: 'checking',
          context: initialContext,
          event: null,
          timestamp: now,
        },
      ],
      createdAt: now,
    };
    sessions.set(sessionId, session);
    return sessionId;
  },

  getSession(sessionId) {
    return sessions.get(sessionId) ?? null;
  },

  appendState(sessionId, entry) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const stateEntry: StateEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...entry,
    };

    session.history.push(stateEntry);
    session.value = entry.value;
    session.context = entry.context;
  },
};
