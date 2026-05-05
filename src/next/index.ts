import {
  createSessionHttpController,
  type SessionHttpController,
  type SessionHttpControllerOptions,
} from '../http/index.js';
import type { AgentMachine } from '../types.js';

type AnyMachine = AgentMachine<any, any, any, any, any, any>;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface NextRouteContext<TParams extends Record<string, string>> {
  params: Promise<TParams> | TParams;
}

export interface NextSessionRouteHandlers<TMachine extends AnyMachine> {
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
  stream: {
    GET(
      request: Request,
      context: NextRouteContext<{ sessionId: string }>
    ): Promise<Response>;
  };
  controller: SessionHttpController<TMachine>;
}

export function createNextSessionRouteHandlers<TMachine extends AnyMachine>(
  machine: TMachine,
  options: SessionHttpControllerOptions<TMachine> = {}
): NextSessionRouteHandlers<TMachine> {
  const controller = createSessionHttpController(machine, options);

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
    events: {
      async POST(request, context) {
        const { sessionId } = await context.params;
        return controller.handle(rewritePath(request, `/sessions/${sessionId}/events`));
      },
    },
    stream: {
      async GET(request, context) {
        const { sessionId } = await context.params;
        return controller.handle(rewritePath(request, `/sessions/${sessionId}/stream`));
      },
    },
    controller,
  };
}

function rewritePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}
