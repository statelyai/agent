import { type RunStore } from '../src/index.js';
import {
  createPersistenceSessionHttpHandler,
  type SessionHttpHandlerOptions,
} from './http-session.js';
import {
  createStreamingSessionHttpController,
  type StreamingSessionHttpController,
} from './http-streaming-session.js';

/**
 * Suggested route-segment config for Next.js App Router route handlers that
 * host long-lived agent sessions and streaming responses.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface NextRouteContext<TParams extends Record<string, string>> {
  params: Promise<TParams> | TParams;
}

export interface NextReviewRouteHandlers {
  sessions: {
    POST(request: Request): Promise<Response>;
  };
  session: {
    GET(
      request: Request,
      context: NextRouteContext<{ sessionId: string }>
    ): Promise<Response>;
  };
  events: {
    POST(
      request: Request,
      context: NextRouteContext<{ sessionId: string }>
    ): Promise<Response>;
  };
}

export interface NextStreamingRouteHandlers {
  sessions: {
    POST(request: Request): Promise<Response>;
  };
  session: {
    GET(
      request: Request,
      context: NextRouteContext<{ sessionId: string }>
    ): Promise<Response>;
  };
  stream: {
    GET(
      request: Request,
      context: NextRouteContext<{ sessionId: string }>
    ): Promise<Response>;
  };
  advance(streamId: string): void;
  dropActiveSession(sessionId: string): void;
}

export function createNextReviewRouteHandlers(
  options: SessionHttpHandlerOptions = {}
): NextReviewRouteHandlers {
  const handle = createPersistenceSessionHttpHandler(options);

  return {
    sessions: {
      POST(request) {
        return handle(rewritePath(request, '/sessions'));
      },
    },
    session: {
      async GET(request, context) {
        const { sessionId } = await context.params;
        return handle(rewritePath(request, `/sessions/${sessionId}`));
      },
    },
    events: {
      async POST(request, context) {
        const { sessionId } = await context.params;
        return handle(rewritePath(request, `/sessions/${sessionId}/events`));
      },
    },
  };
}

export function createNextStreamingRouteHandlers(options: {
  store?: RunStore;
} = {}): NextStreamingRouteHandlers {
  const controller = createStreamingSessionHttpController(options);

  return {
    sessions: {
      POST(request) {
        return controller.handle(rewritePath(request, '/sessions'));
      },
    },
    session: {
      async GET(request, context) {
        const { sessionId } = await context.params;
        return controller.handle(rewritePath(request, `/sessions/${sessionId}`));
      },
    },
    stream: {
      async GET(request, context) {
        const { sessionId } = await context.params;
        return controller.handle(
          rewritePath(request, `/sessions/${sessionId}/stream`)
        );
      },
    },
    advance(streamId) {
      controller.advance(streamId);
    },
    dropActiveSession(sessionId) {
      controller.dropActiveSession(sessionId);
    },
  };
}

function rewritePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}
