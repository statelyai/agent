import {
  createMemoryRunStore,
} from '../runtime/memory-store.js';
import {
  restoreSession,
  startSession,
} from '../runtime/session.js';
import type {
  AgentMachine,
  AgentRun,
  RunStore,
  TransitionEvent,
} from '../types.js';

type AnyMachine = AgentMachine<any, any, any, any, any, any>;
type RunFor<TMachine extends AnyMachine> =
  TMachine extends AgentMachine<
    any,
    infer TContext,
    infer TEvents,
    infer TStates,
    infer TOutput,
    infer TEmitted
  >
    ? AgentRun<TContext, keyof TStates & string, TEvents, TOutput, TEmitted>
    : AgentRun;

type InputFor<TMachine extends AnyMachine> =
  TMachine extends AgentMachine<infer TInput, any, any, any, any, any>
    ? TInput
    : unknown;

type EventsFor<TMachine extends AnyMachine> =
  TMachine extends AgentMachine<any, any, infer TEvents, any, any, any>
    ? TEvents
    : {};

export interface SessionHttpController<TMachine extends AnyMachine> {
  handle(request: Request): Promise<Response>;
  getRun(sessionId: string): Promise<RunFor<TMachine>>;
  dropActiveSession(sessionId: string): void;
}

export interface SessionHttpControllerOptions<TMachine extends AnyMachine> {
  store?: RunStore;
  parseInput?: (request: Request) => Promise<InputFor<TMachine>>;
  parseEvent?: (
    request: Request
  ) => Promise<TransitionEvent<EventsFor<TMachine>>>;
}

export function createSessionHttpController<TMachine extends AnyMachine>(
  machine: TMachine,
  options: SessionHttpControllerOptions<TMachine> = {}
): SessionHttpController<TMachine> {
  const store = options.store ?? createMemoryRunStore();
  const activeRuns = new Map<string, RunFor<TMachine>>();
  const parseInput =
    options.parseInput ?? ((request) => request.json() as Promise<InputFor<TMachine>>);
  const parseEvent =
    options.parseEvent ??
    ((request) => request.json() as Promise<TransitionEvent<EventsFor<TMachine>>>);

  function trackRun(run: RunFor<TMachine>): RunFor<TMachine> {
    activeRuns.set(run.sessionId, run);
    run.onDone(() => {
      activeRuns.delete(run.sessionId);
    });
    run.onError(() => {
      activeRuns.delete(run.sessionId);
    });
    return run;
  }

  async function getRun(sessionId: string): Promise<RunFor<TMachine>> {
    const existing = activeRuns.get(sessionId);
    if (existing) {
      return existing;
    }

    const restored = await restoreSession(machine, {
      sessionId,
      store,
    }) as RunFor<TMachine>;

    return trackRun(restored);
  }

  return {
    getRun,

    dropActiveSession(sessionId) {
      activeRuns.delete(sessionId);
    },

    async handle(request) {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/sessions(?:\/([^/]+)(?:\/(events|stream))?)?$/);
      const sessionId = match?.[1];
      const childRoute = match?.[2];

      if (request.method === 'POST' && url.pathname === '/sessions') {
        const run = await startSession(machine, {
          store,
          input: await parseInput(request),
        }) as RunFor<TMachine>;

        trackRun(run);

        return Response.json({
          sessionId: run.sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      if (request.method === 'GET' && sessionId && !childRoute) {
        const run = await getRun(sessionId);

        return Response.json({
          sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      if (request.method === 'POST' && sessionId && childRoute === 'events') {
        const run = await getRun(sessionId);
        await run.send(await parseEvent(request));

        return Response.json({
          sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      if (request.method === 'GET' && sessionId && childRoute === 'stream') {
        return createRunSseResponse(await getRun(sessionId));
      }

      return new Response('Not found', { status: 404 });
    },
  };
}

export function createSessionHttpHandler<TMachine extends AnyMachine>(
  machine: TMachine,
  options: SessionHttpControllerOptions<TMachine> = {}
): (request: Request) => Promise<Response> {
  const controller = createSessionHttpController(machine, options);
  return (request) => controller.handle(request);
}

export function createRunSseResponse(
  run: AgentRun<any, any, any, any, any>
): Response {
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      if (run.getSnapshot().status === 'done') {
        write('done', run.getSnapshot().output);
        controller.close();
        return;
      }

      if (run.getSnapshot().status === 'error') {
        write('error', { error: String(run.getSnapshot().error) });
        controller.close();
        return;
      }

      const offEmitted = run.onEmitted((event) => {
        write(event.type, event);
      });
      const offDone = run.onDone((event) => {
        write('done', event.output);
        cleanup();
        controller.close();
      });
      const offError = run.onError((event) => {
        write('error', { error: String(event.error) });
        cleanup();
        controller.close();
      });

      cleanup = () => {
        offEmitted();
        offDone();
        offError();
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}
