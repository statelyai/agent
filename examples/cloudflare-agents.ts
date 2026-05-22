import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import type { RunStore } from '../src/index.js';
import {
  createCloudflareAgentRunStore,
  type CloudflareAgentRunStoreState,
} from '../src/cloudflare/index.js';
import { createPersistenceExample } from './persistence.js';

export {
  createCloudflareAgentRunStore,
  type CloudflareAgentRunStoreState,
};

export interface CloudflareAgentsExampleArtifacts {
  ReviewWorkflowAgent: new (...args: any[]) => {
    onRequest(request: Request): Promise<Response>;
  };
  worker: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
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
