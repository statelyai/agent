import {
  restoreSession,
  startSession,
  type RunStore,
} from '../src/index.js';
import {
  createDurableObjectRunStore,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
} from '../src/cloudflare/index.js';
import { createPersistenceExample } from './persistence.js';

export {
  createDurableObjectRunStore,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
};

export class AgentSessionDurableObject {
  private readonly store: RunStore;

  constructor(private readonly state: DurableObjectStateLike) {
    this.store = createDurableObjectRunStore(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const machine = createPersistenceExample(async ({ request, approved }) => ({
      summary: `${request} :: approved=${String(approved)}`,
    }));

    if (request.method === 'POST' && url.pathname === '/start') {
      const body = await request.json() as { request: string };
      const run = await startSession(machine, {
        store: this.store,
        input: { request: body.request },
      });

      return Response.json({
        sessionId: run.sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/approve') {
      const sessionId = requiredSessionId(url);
      const run = await restoreSession(machine, {
        store: this.store,
        sessionId,
      });

      await run.send({ type: 'approve' });

      return Response.json({
        sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      const sessionId = requiredSessionId(url);
      const run = await restoreSession(machine, {
        store: this.store,
        sessionId,
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
