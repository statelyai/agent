import {
  createMemoryRunStore,
  restoreSession,
  startSession,
  type RunStore,
} from '../src/index.js';
import { createPersistenceExample } from './persistence.js';

export interface SessionHttpHandlerOptions {
  store?: RunStore;
  summarize?: Parameters<typeof createPersistenceExample>[0];
}

export function createPersistenceSessionHttpHandler(
  options: SessionHttpHandlerOptions = {}
) {
  const store = options.store ?? createMemoryRunStore();
  const machine = createPersistenceExample(options.summarize);

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/sessions(?:\/([^/]+)(?:\/events)?)?$/);
    const sessionId = match?.[1];
    const isEventRoute = url.pathname.endsWith('/events');

    if (request.method === 'POST' && url.pathname === '/sessions') {
      const body = await request.json() as { request: string };
      const run = await startSession(machine, {
        store,
        input: { request: body.request },
      });

      return Response.json({
        sessionId: run.sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    if (request.method === 'GET' && sessionId && !isEventRoute) {
      const run = await restoreSession(machine, {
        sessionId,
        store,
      });

      return Response.json({
        sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    if (request.method === 'POST' && sessionId && isEventRoute) {
      const event = await request.json() as { type: 'approve' };
      const run = await restoreSession(machine, {
        sessionId,
        store,
      });

      await run.send(event);

      return Response.json({
        sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    return new Response('Not found', { status: 404 });
  };
}
