import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import type { AgentSnapshot } from '../src/index.js';
import {
  createDurableObjectRunStore,
  type DurableObjectStateLike,
} from './cloudflare-durable-object.js';
import { createMultiAgentNetworkExample } from './multi-agent-network.js';

export class AgentNetworkDurableObject {
  private readonly store;

  constructor(private readonly state: DurableObjectStateLike) {
    this.store = createDurableObjectRunStore(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const machine = createMultiAgentNetworkExample({
      adapter: {
        decide: async ({ prompt }) => {
          if (!prompt.includes('Notes: none yet')) {
            if (!prompt.includes('Current draft: none yet')) {
              return { choice: 'finalize', data: {} };
            }

            return {
              choice: 'write',
              data: { angle: 'turn the current notes into a concise summary' },
            };
          }

          return {
            choice: 'research',
            data: { focus: 'collect the strongest supporting facts' },
          };
        },
      },
      research: async ({ topic, focus }) => ({
        notes: [`${topic}:${focus}:1`, `${topic}:${focus}:2`],
      }),
      write: async ({ topic, notes, angle }) => ({
        draft: `${topic} | ${angle} | ${notes.join(' / ')}`,
      }),
    });

    if (request.method === 'POST' && url.pathname === '/start') {
      const body = await request.json() as { topic: string };
      const run = await startSession(machine, {
        store: this.store,
        input: { topic: body.topic },
      });

      return Response.json({
        sessionId: run.sessionId,
        snapshot: run.getSnapshot(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/resume') {
      const sessionId = requiredSessionId(url);
      const run = await restoreSession(machine, {
        sessionId,
        store: this.store,
      });
      const snapshot = await waitForTerminalSnapshot(run.getSnapshot, 1000);

      return Response.json({
        sessionId,
        snapshot,
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

async function waitForTerminalSnapshot(
  getSnapshot: () => AgentSnapshot,
  timeoutMs: number
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const snapshot = getSnapshot();
    if (snapshot.status === 'done' || snapshot.status === 'error') {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return getSnapshot();
}

function requiredSessionId(url: URL): string {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    throw new Error('Missing sessionId');
  }

  return sessionId;
}
