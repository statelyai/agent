import { Agent } from 'agents';
import { restoreSession, startSession, type RunStore } from '../../../../src/index.js';
import {
  createCloudflareAgentRunStore,
  type CloudflareAgentRunStoreState,
} from '../../../cloudflare-agents.js';
import { createPersistenceExample } from '../../../persistence.js';

export class ReviewWorkflowAgent extends Agent<
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
    const machine = createPersistenceExample();

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

function requiredSessionId(url: URL): string {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    throw new Error('Missing sessionId');
  }

  return sessionId;
}
