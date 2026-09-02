import type { AnyStateMachine, EmittedFrom, EventFromLogic, StateValue } from "xstate";
import type { AgentStepRequest } from "./steps.js";
import {
  runAgent,
  type AgentTraceEvent,
  type RunAgentOptions,
  type RunAgentResult,
} from "./run-agent.js";

/**
 * A live handle over a single {@link runAgent} call: its trace events as an
 * async stream, plus the same result promise `runAgent` returns.
 *
 * Build it with {@link createAgentRun}. Use `events` for a pull-based feed
 * (SSE, a JSONL logger, a progress UI) and `result` for the final outcome —
 * either, both, or neither; nothing about consuming one is required to consume
 * the other.
 */
export interface AgentRun<TMachine extends AnyStateMachine = AnyStateMachine> {
  /**
   * Single-consumer async stream of the run's trace events, in `runAgent`'s
   * emission order (`run.start` → request/chunk/transition/emit events →
   * `run.end`). Completes right after `run.end` is delivered. Events are
   * buffered unboundedly, so a slow or absent consumer never blocks the run
   * (see {@link createAgentRun}). Single-consumer: a second `for await` over the
   * same iterator picks up only the events not yet pulled — it is one shared
   * cursor, not a fresh replay.
   */
  events: AsyncIterableIterator<AgentTraceEvent<TMachine>>;
  /**
   * Settles exactly like {@link runAgent}'s return value: resolves with the
   * `done | idle | error` {@link RunAgentResult}, and rejects only where
   * `runAgent` itself rejects (bind-time programmer errors — a missing
   * executor, an illegal resume event, a version mismatch). A run-level failure
   * still resolves with `{ status: 'error' }`, never rejects.
   */
  result: Promise<RunAgentResult<TMachine>>;
}

/**
 * Wraps {@link runAgent} in a canonical run-stream handle: the run's trace
 * events as a pull-based {@link AgentRun.events} async iterator, alongside the
 * unchanged {@link AgentRun.result} promise.
 *
 * Semantics:
 *
 * 1. **Starts immediately.** The underlying `runAgent` is invoked on this call,
 *    not on the first `events` iteration — work is already in flight when
 *    `createAgentRun` returns.
 * 2. **Buffer, don't stall.** Events are queued in an unbounded in-memory
 *    buffer as the run emits them; a slow or absent consumer never applies
 *    backpressure to the run. Once `run.end` is delivered, the iterator
 *    completes.
 * 3. **Composes `onTrace`.** If `options.onTrace` is passed, it still fires for
 *    every event — the wrapper adds queue delivery, it does not replace the
 *    caller's sink.
 * 4. **`result` mirrors `runAgent`.** Same resolution and rejection behavior
 *    (see {@link AgentRun.result}). A no-op rejection handler is attached
 *    internally so a caller who reads only `events` never trips an unhandled
 *    rejection on a bind-time throw; the returned promise still rejects for a
 *    caller who awaits it.
 * 5. **Resume is identical.** Options pass straight through, so starting from a
 *    persisted `snapshot` (+ resume `event`) streams that run's events from its
 *    own `run.start`, exactly as `runAgent` would run it.
 * 6. **Early termination does not cancel the run.** Breaking out of a
 *    `for await` (or calling `events.return()`) stops delivery, but the run
 *    keeps going and `result` still settles. Cancelling the run itself is
 *    future work — pass `options.signal` to abort it.
 * 7. **`events` is single-consumer.** See {@link AgentRun.events}.
 */
export function createAgentRun<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): AgentRun<TMachine> {
  type Event = AgentTraceEvent<TMachine>;
  type Result = IteratorResult<Event>;

  // Simple unbounded async queue: the onTrace wrapper pushes; the iterator
  // pulls. A pending `next()` parks a resolver here; an event arriving before
  // any pull is buffered. `push`/`next` keep these mutually exclusive — a
  // resolver is only ever parked while the buffer is empty — so closing by
  // flushing parked resolvers with `done` can never strand a buffered event.
  const buffer: Event[] = [];
  const resolvers: Array<(result: Result) => void> = [];
  let closed = false; // no further events will arrive (run.end delivered, or the run settled)
  let stopped = false; // the consumer ended the iterator early (break / return())

  const push = (event: Event): void => {
    if (closed || stopped) {
      return;
    }
    const resolve = resolvers.shift();
    if (resolve) {
      resolve({ value: event, done: false });
    } else {
      buffer.push(event);
    }
  };

  // Completes every parked `next()` with `done` — the one way this queue ends,
  // whether the run closed it or the consumer stopped iterating.
  const drain = (): void => {
    while (resolvers.length > 0) {
      resolvers.shift()!({ value: undefined, done: true });
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    drain();
  };

  // Compose, don't replace: deliver to the queue, then fan out to the caller's
  // own onTrace. Delivery happens first so an event is queued even if the
  // caller's sink throws. `run.end` closes the stream, but only after it has
  // itself been delivered — so the consumer sees `run.end`, then completion.
  const userOnTrace = options.onTrace;
  const result = runAgent(machine, {
    ...options,
    onTrace: (event) => {
      push(event as Event);
      userOnTrace?.(event);
      if (event.type === "run.end") {
        close();
      }
    },
  });

  // Backstop: close the stream when the run settles, regardless of trace
  // events. Covers the bind-time rejection path (no trace events fire, so
  // `run.end` never closes the queue) and is idempotent with the `run.end`
  // close above on every normal settle. Supplying a rejection handler here
  // also marks `result` handled, so a consumer reading only `events` never
  // trips an unhandled rejection; the `result` promise returned below is the
  // original and still rejects for a consumer who awaits it.
  result.then(close, close);

  const events: AsyncIterableIterator<Event> = {
    next(): Promise<Result> {
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift()!, done: false });
      }
      if (closed || stopped) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<Result>((resolve) => {
        resolvers.push(resolve);
      });
    },
    return(): Promise<Result> {
      // Early termination: stop delivery and drop anything buffered, but leave
      // the run untouched — it continues and `result` still settles.
      stopped = true;
      buffer.length = 0;
      drain();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return { events, result };
}

export type AgentStreamEvent<TMachine extends AnyStateMachine = AnyStateMachine> =
  | {
      kind: "request";
      phase: "start" | "end";
      name: string;
      id: string;
      request: AgentStepRequest;
      output?: unknown;
      raw?: unknown;
    }
  | {
      kind: "request";
      phase: "error";
      name: string;
      id: string;
      request: AgentStepRequest;
      error: unknown;
    }
  | { kind: "chunk"; name: string; id: string; delta: string }
  | {
      kind: "transition";
      value: StateValue;
      event: EventFromLogic<TMachine>;
    }
  | { kind: "emit"; event: EmittedFrom<TMachine> }
  | { kind: "done"; result: Extract<RunAgentResult<TMachine>, { status: "done" }> }
  | { kind: "idle"; result: Extract<RunAgentResult<TMachine>, { status: "idle" }> }
  | { kind: "error"; result: Extract<RunAgentResult<TMachine>, { status: "error" }> };

function requestIdentity(request: AgentStepRequest): { name: string; id: string } {
  const candidate = request as {
    id?: string;
    name?: string;
    kind?: string;
    input?: { name?: string };
  };
  const id = candidate.id ?? candidate.name ?? "agent.request";
  const name = candidate.kind === "text" ? (candidate.input?.name ?? id) : (candidate.name ?? id);
  return { name, id };
}

/**
 * Streams one {@link runAgent} call as agent-level events. The machine remains
 * the single artifact; this function only projects its requests, chunks,
 * transitions, emitted events, and terminal result into an async iterable.
 */
export async function* runAgentStream<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): AsyncGenerator<AgentStreamEvent<TMachine>, void> {
  const run = createAgentRun(machine, options);

  for await (const event of run.events) {
    switch (event.type) {
      case "request.start": {
        const identity = requestIdentity(event.request);
        yield { kind: "request", phase: "start", ...identity, request: event.request };
        break;
      }
      case "request.end": {
        const identity = requestIdentity(event.request);
        yield {
          kind: "request",
          phase: "end",
          ...identity,
          request: event.request,
          output: event.output,
          raw: event.raw,
        };
        break;
      }
      case "request.error": {
        const identity = requestIdentity(event.request);
        yield {
          kind: "request",
          phase: "error",
          ...identity,
          request: event.request,
          error: event.error,
        };
        break;
      }
      case "stream.chunk": {
        const identity = requestIdentity(event.request);
        yield { kind: "chunk", ...identity, delta: event.chunk };
        break;
      }
      case "machine.transition":
        yield {
          kind: "transition",
          value: (event.snapshot as { value: StateValue }).value,
          event: event.event,
        };
        break;
      case "emit":
        yield { kind: "emit", event: event.event };
        break;
    }
  }

  const result = await run.result;
  if (result.status === "done") {
    yield { kind: "done", result };
  } else if (result.status === "idle") {
    yield { kind: "idle", result };
  } else {
    yield { kind: "error", result };
  }
}
