import {
  restoreSession,
  startSession,
  type JournalEventRecord,
  type PersistedSnapshot,
  type RunStore,
} from '../src/index.js';
import { createPersistenceExample } from './persistence.js';

type SessionEntry = {
  events: JournalEventRecord[];
  snapshot: PersistedSnapshot | null;
};

export type CloudflareAgentRunStoreState = {
  sessions: Record<string, SessionEntry>;
};

export interface CloudflareAgentsExampleArtifacts {
  ReviewWorkflowAgent: new (...args: any[]) => {
    onRequest(request: Request): Promise<Response>;
  };
  worker: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
}

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

/**
 * Cloudflare's `agents` package imports `cloudflare:` modules, so this example
 * keeps that import lazy to stay loadable in plain Node. In a real Worker,
 * move the `agents` imports to top-level imports.
 */
export async function createCloudflareAgentsExample(): Promise<CloudflareAgentsExampleArtifacts> {
  const { Agent, routeAgentRequest } = await import('agents');
  const machine = createPersistenceExample();

  class ReviewWorkflowAgent extends Agent<
    Record<string, unknown>,
    CloudflareAgentRunStoreState
  > {
    initialState: CloudflareAgentRunStoreState = {
      sessions: {},
    };

    private getStore(): RunStore {
      return createCloudflareAgentRunStore({
        getState: () => this.state ?? this.initialState,
        setState: (nextState) => this.setState(nextState),
      });
    }

    async onRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname.endsWith('/start')) {
        const body = await request.json() as { request: string };
        const run = await startSession(machine, {
          store: this.getStore(),
          input: {
            request: body.request,
          },
        });

        return Response.json({
          sessionId: run.sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      if (request.method === 'POST' && url.pathname.endsWith('/events')) {
        const body = await request.json() as {
          sessionId: string;
          event: { type: 'approve' };
        };
        const run = await restoreSession(machine, {
          sessionId: body.sessionId,
          store: this.getStore(),
        });

        await run.send(body.event);

        return Response.json({
          sessionId: body.sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      if (request.method === 'GET' && url.pathname.endsWith('/snapshot')) {
        const sessionId = requiredSessionId(url);
        const run = await restoreSession(machine, {
          sessionId,
          store: this.getStore(),
        });

        return Response.json({
          sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      return new Response('Not found', { status: 404 });
    }
  }

  const worker = {
    async fetch(request: Request, env: Record<string, unknown>) {
      return (
        await routeAgentRequest(request, env, {
          prefix: '/agents',
        })
      ) ?? new Response('Not found', { status: 404 });
    },
  };

  return {
    ReviewWorkflowAgent,
    worker,
  } satisfies CloudflareAgentsExampleArtifacts;
}

function requiredSessionId(url: URL): string {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    throw new Error('Missing sessionId');
  }

  return sessionId;
}
