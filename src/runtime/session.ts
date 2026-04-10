import type { JournalEvent } from './events.js';
import { createRunEmitter } from './emitter.js';
import type {
  AgentMachine,
  AgentRun,
  AgentSnapshot,
  AgentState,
  EmittedPart,
  RestoreSessionOptions,
  SessionOptions,
} from '../types.js';
import { isReservedInternalEventType } from '../utils.js';

type SnapshotRuntime = {
  sessionId: string;
  createdAt: number;
};

type RuntimeMachine = AgentMachine & {
  __runtime: {
    toSnapshot(state: AgentState, runtime: SnapshotRuntime): AgentSnapshot;
    withRuntimeMetadata(state: AgentState, runtime: SnapshotRuntime): AgentState;
    getEffectEvent(
      state: AgentState,
      onEmit?: (part: EmittedPart) => void
    ): Promise<JournalEvent | null>;
    resolveEffectTransition(
      state: AgentState,
      effectEvent: JournalEvent,
      onEmit?: (part: EmittedPart) => void
    ): { event: JournalEvent; next: AgentState };
    transitionWithEffects(
      state: AgentState,
      event: { type: string; [key: string]: unknown },
      onEmit?: (part: EmittedPart) => void
    ): { next: AgentState; emitted: EmittedPart[] };
  };
};

type RunState = {
  current: AgentState;
  snapshot: AgentSnapshot;
  lastSequence: number;
  runtime: SnapshotRuntime;
};

function createSessionId(): string {
  if (
    typeof globalThis.crypto !== 'undefined'
    && typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }

  return `session-${Math.random().toString(36).slice(2)}`;
}

function asRuntimeMachine(machine: AgentMachine): RuntimeMachine {
  const runtimeMachine = machine as RuntimeMachine;
  if (!runtimeMachine.__runtime) {
    throw new Error('Machine runtime internals are unavailable');
  }

  return runtimeMachine;
}

function toJournalEvent(
  event: { type: string; [key: string]: unknown }
): JournalEvent {
  return {
    ...event,
    at: typeof event.at === 'number' ? event.at : Date.now(),
  };
}

function createRun(
  machine: AgentMachine,
  store: SessionOptions['store'],
  runtimeMachine: RuntimeMachine,
  runState: RunState,
  emitter = createRunEmitter()
): AgentRun {
  let releaseStart!: () => void;
  let operation = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let startScheduled = false;
  let terminalEmitted = false;

  function emitPart(part: EmittedPart) {
    emitter.emit('part', part);
    emitter.emit(part.type, part);
  }

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = operation.then(op);
    operation = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }

  function emitTerminalIfNeeded() {
    if (terminalEmitted) {
      return;
    }

    if (runState.snapshot.status === 'done') {
      terminalEmitted = true;
      emitter.emit('runtime', {
        type: 'session.completed',
        sessionId: runState.runtime.sessionId,
        at: Date.now(),
      });
      emitter.emit('done', {
        output: runState.snapshot.output,
        snapshot: runState.snapshot,
      });
      return;
    }

    if (runState.snapshot.status === 'error') {
      terminalEmitted = true;
      emitter.emit('runtime', {
        type: 'session.failed',
        sessionId: runState.runtime.sessionId,
        error: runState.snapshot.error,
        at: Date.now(),
      });
      emitter.emit('error', {
        error: runState.snapshot.error,
        snapshot: runState.snapshot,
      });
    }
  }

  async function persistSnapshot() {
    runState.snapshot = runtimeMachine.__runtime.toSnapshot(
      runState.current,
      runState.runtime
    );

    await store.saveSnapshot({
      sessionId: runState.runtime.sessionId,
      afterSequence: runState.lastSequence,
      snapshot: runState.snapshot,
      createdAt: Date.now(),
    });

    emitter.emit('runtime', {
      type: 'snapshot.persisted',
      sessionId: runState.runtime.sessionId,
      afterSequence: runState.lastSequence,
      at: Date.now(),
    });
    emitter.emit('state', runState.snapshot);
    emitTerminalIfNeeded();
  }

  async function appendMachineEvent(event: JournalEvent) {
    const record = await store.append(runState.runtime.sessionId, event);
    runState.lastSequence = record.sequence;
    emitter.emit('machine.event', {
      ...event,
      sequence: record.sequence,
    });
  }

  async function settle() {
    while (runState.current.status === 'active') {
      const effectEvent = await runtimeMachine.__runtime.getEffectEvent(
        runState.current,
        emitPart
      );

      if (effectEvent) {
        const resolved = runtimeMachine.__runtime.resolveEffectTransition(
          runState.current,
          effectEvent,
          emitPart
        );

        await appendMachineEvent(resolved.event);
        runState.current = runtimeMachine.__runtime.withRuntimeMetadata(
          resolved.next,
          runState.runtime
        );
        await persistSnapshot();
        continue;
      }

      runState.current = runtimeMachine.__runtime.withRuntimeMetadata(
        await machine.invoke(runState.current),
        runState.runtime
      );
      await persistSnapshot();
    }
  }

  function scheduleStart() {
    if (startScheduled) {
      return;
    }

    startScheduled = true;
    void enqueue(async () => {
      await settle();
    });
    queueMicrotask(() => {
      releaseStart();
    });
  }

  return {
    get sessionId() {
      return runState.runtime.sessionId;
    },

    get status() {
      return runState.snapshot.status;
    },

    getSnapshot() {
      return runState.snapshot;
    },

    async send(event) {
      if (isReservedInternalEventType(event.type)) {
        throw new Error(
          `Cannot send reserved internal event '${event.type}' to a session`
        );
      }

      return enqueue(async () => {
        const journalEvent = toJournalEvent(event);
        const next = runtimeMachine.__runtime.transitionWithEffects(
          runState.current,
          journalEvent,
          emitPart
        ).next;

        await appendMachineEvent(journalEvent);
        runState.current = runtimeMachine.__runtime.withRuntimeMetadata(
          next,
          runState.runtime
        );
        await persistSnapshot();
        await settle();
      });
    },

    on(type, handler) {
      return emitter.on(type, handler);
    },

    /** @internal */
    async __persistCurrent() {
      await persistSnapshot();
    },

    /** @internal */
    async __settle() {
      await enqueue(async () => {
        await settle();
      });
    },

    /** @internal */
    __scheduleStart() {
      scheduleStart();
    },
  } as AgentRun;
}

export async function startSession(
  machine: AgentMachine,
  options: SessionOptions
): Promise<AgentRun> {
  const runtimeMachine = asRuntimeMachine(machine);
  const initialState = machine.getInitialState(options.input);
  const runtime = {
    sessionId: options.sessionId ?? createSessionId(),
    createdAt: Date.now(),
  };
  const runState: RunState = {
    current: runtimeMachine.__runtime.withRuntimeMetadata(initialState, runtime),
    snapshot: runtimeMachine.__runtime.toSnapshot(initialState, runtime),
    lastSequence: 0,
    runtime,
  };

  const run = createRun(
    machine,
    options.store,
    runtimeMachine,
    runState
  ) as AgentRun & {
    __persistCurrent(): Promise<void>;
    __settle(): Promise<void>;
    __scheduleStart(): void;
  };

  const initEvent = {
    type: 'xstate.init',
    input: options.input,
    at: runtime.createdAt,
  } satisfies JournalEvent;
  const record = await options.store.append(runtime.sessionId, initEvent);
  runState.lastSequence = record.sequence;

  await run.__persistCurrent();
  run.__scheduleStart();

  return run;
}

export async function restoreSession(
  machine: AgentMachine,
  options: RestoreSessionOptions
): Promise<AgentRun> {
  const runtimeMachine = asRuntimeMachine(machine);
  const persisted = await options.store.loadLatestSnapshot(options.sessionId);
  const allEvents = await options.store.loadEvents(options.sessionId);
  const initEvent = allEvents.find(
    (event) => event.type === 'xstate.init'
  );

  if (!persisted && !initEvent) {
    throw new Error(`No persisted session '${options.sessionId}' found`);
  }

  const runtime = {
    sessionId: options.sessionId,
    createdAt: persisted?.snapshot.createdAt ?? initEvent?.at ?? Date.now(),
  };
  const initialState = persisted
    ? machine.resolveState(persisted.snapshot)
    : machine.getInitialState(initEvent?.input);
  const runState: RunState = {
    current: runtimeMachine.__runtime.withRuntimeMetadata(initialState, runtime),
    snapshot:
      persisted?.snapshot
      ?? runtimeMachine.__runtime.toSnapshot(initialState, runtime),
    lastSequence: persisted?.afterSequence ?? (initEvent?.sequence ?? 0),
    runtime,
  };
  const run = createRun(
    machine,
    options.store,
    runtimeMachine,
    runState
  ) as AgentRun & {
    __persistCurrent(): Promise<void>;
    __settle(): Promise<void>;
    __scheduleStart(): void;
  };

  const replayTail = await options.store.loadEvents(
    options.sessionId,
    runState.lastSequence
  );
  let replayed = false;

  for (const event of replayTail) {
    runState.current = runtimeMachine.__runtime.withRuntimeMetadata(
      machine.transition(runState.current, event),
      runState.runtime
    );
    runState.lastSequence = event.sequence;
    runState.snapshot = runtimeMachine.__runtime.toSnapshot(
      runState.current,
      runState.runtime
    );
    replayed = true;
  }

  if (!persisted || replayed) {
    await run.__persistCurrent();
  }
  run.__scheduleStart();

  return run;
}
