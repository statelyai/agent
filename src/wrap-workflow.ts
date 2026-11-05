/**
 * `wrapWorkflow` — step 0 of a strangler-fig retrofit: an existing async
 * workflow, unchanged, as an agent machine.
 * @module
 */
import { createAsyncLogic, type AnyActorLogic } from "xstate";
import type { PresetMachine } from "./machines/internal.js";
import { AgentError } from "./errors.js";
import type { Recorder } from "./equivalence.js";
import type { JsonValue } from "./event-log.js";
import { runAgent, toJsonValue, type AgentRunOptions } from "./run-agent.js";
import { setupAgent } from "./setup-agent.js";
import type { StandardSchemaV1 } from "./types.js";
import { isAsyncIterable, mapEffects } from "./internal/effects.js";

/** The effects a wrapped workflow calls: async functions, by name. */
export type WorkflowEffects<TEffects> = {
  [K in keyof TEffects]: (...args: never[]) => PromiseLike<unknown>;
};

/** What a wrapped workflow's `run` gets besides its input and effects. */
export interface WorkflowRunContext {
  /** Aborted when the run is aborted or the machine stops the workflow. */
  signal: AbortSignal;
}

/** Options for {@link wrapWorkflow}. */
export interface WrapWorkflowConfig<TInput, TOutput, TEffects extends WorkflowEffects<TEffects>> {
  /** The machine id. */
  id: string;
  /** The machine version, for the event log. Default `"1"`. */
  version?: string;
  /** Every side effect the workflow makes: model calls, tools, writes. */
  effects: TEffects;
  /**
   * The existing workflow. It must reach the outside world only through
   * `effects`; a call it makes around them is invisible to the machine, to
   * traces, and to {@link Recorder} recordings. It gets its own deep copy of
   * a plain-data input, free to mutate; an input holding class instances or
   * functions is passed as is. An effect that resolves to a stream (anything
   * `for await` reads) settles once the stream is read, with its chunks.
   */
  run: (input: TInput, effects: TEffects, context: WorkflowRunContext) => PromiseLike<TOutput>;
  /**
   * Maps an effect's arguments, result, or error before it is journaled as an
   * event. Return a redacted value for secrets and private records: every
   * `effect.*` event reaches traces, the event log, and the inspector.
   * Default: journal each value as is (JSON-safe).
   */
  redact?: (name: string, part: "args" | "result" | "error", value: unknown) => unknown;
}

/** An effect call, as the machine sees it. `call` pairs it with its result. */
export interface EffectCallEvent {
  type: "effect.call";
  name: string;
  /** 0-based, across all effects of the run. */
  call: number;
  /** The arguments, JSON-safe. */
  args: JsonValue[];
}

/** An effect call that resolved. */
export interface EffectDoneEvent {
  type: "effect.done";
  name: string;
  call: number;
  /**
   * The resolved value, JSON-safe (`null` for `undefined`). For a stream, the
   * chunks read, or `{ chunks, returned }` when a generator returned a value.
   */
  result: JsonValue;
}

/** An effect call that rejected. */
export interface EffectErrorEvent {
  type: "effect.error";
  name: string;
  call: number;
  /** The error, JSON-safe: `{ name, message, stack?, code? }`. */
  error: JsonValue;
}

/** The wrapped machine's context. */
export type WrappedWorkflowContext<TInput, TOutput> = {
  input: TInput;
  /** What the workflow returned, once it did. */
  output?: TOutput;
  /** Effect calls started. */
  calls: number;
  /** Effect calls that rejected. */
  failures: number;
};

/** Options for {@link WrappedWorkflow.run}: `runAgent` options that fit a black box, plus fakes and a recorder. */
export interface WrappedWorkflowRunOptions<TEffects, TInput, TOutput> extends Pick<
  AgentRunOptions<WrappedWorkflowMachine<TInput, TOutput>>,
  "signal" | "inspect" | "onTransition" | "onTrace" | "onEvent" | "metadata" | "verification"
> {
  /** Replaces some effects for this run: fakes, stubs, replay wrappers. */
  effects?: Partial<TEffects>;
  /**
   * Wraps every function effect with `recorder.fn(name, fn)` and records the
   * result with `recorder.output`, so `recorder.recording` is a golden run.
   */
  recorder?: Recorder;
}

/** The result of {@link wrapWorkflow}. */
export interface WrappedWorkflow<TInput, TOutput, TEffects> {
  /**
   * `running` invokes the workflow and counts its effect calls; `done` is
   * final with the workflow's result as output. A rejection is unhandled, so
   * the run settles `{ status: "error", cause: "machine" }` with the thrown
   * error. Runs with `runAgent`, `describeMachine`, `canReach` and the inspector.
   */
  machine: WrappedWorkflowMachine<TInput, TOutput>;
  /**
   * Runs the machine with `runAgent` and returns what the workflow returned,
   * or rethrows what it threw (the same error object). `signal` reaches the
   * workflow, which decides what an abort means, as it did before: a
   * workflow that returns an `aborted` result still returns it. Once it
   * aborts, an effect call throws `signal.reason` instead of running.
   */
  run(
    input: TInput,
    options?: WrappedWorkflowRunOptions<TEffects, TInput, TOutput>,
  ): Promise<TOutput>;
}

/** A schema that only carries a type: values pass through unchecked. */
function typeOnly<T>(): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "statelyai-agent",
      validate: (value: unknown) => ({ value }),
    },
  };
}

type Redact = NonNullable<WrapWorkflowConfig<unknown, unknown, never>["redact"]>;

/**
 * Wraps each effect so its call and settlement reach the machine as events.
 * Once `signal` aborts, an effect throws its reason instead of running, so a
 * workflow that ignores its signal stops spending calls.
 */
function observeEffects<TEffects>(
  effects: TEffects,
  send: (event: object) => void,
  signal: AbortSignal,
  redact: Redact = (_name, _part, value) => value,
): TEffects {
  let calls = 0;
  return mapEffects(effects, (name, effect) => async (...args: unknown[]) => {
    signal.throwIfAborted();
    const call = calls++;
    send({
      type: "effect.call",
      name,
      call,
      args: (toJsonValue(redact(name, "args", args)) ?? []) as JsonValue[],
    });
    const done = (result: unknown) =>
      send({
        type: "effect.done",
        name,
        call,
        result: toJsonValue(redact(name, "result", result)) ?? null,
      });
    const failed = (error: unknown) =>
      send({
        type: "effect.error",
        name,
        call,
        error: toJsonValue(redact(name, "error", error)) ?? null,
      });
    let result: unknown;
    try {
      result = await effect(...args);
    } catch (error) {
      failed(error);
      throw error;
    }
    if (isAsyncIterable(result)) return observeStream(result, done, failed);
    done(result);
    return result;
  });
}

/**
 * A stream that settles its effect once read: `done` with the chunks read
 * (`{ chunks, returned }` when a generator returned a value) when iteration
 * ends or the reader stops early, `failed` if it throws. Reading through
 * `for await`, `[Symbol.asyncIterator]().next()`, or a generator's own
 * `next()` is observed alike; anything else reaches the original stream,
 * bound to it.
 */
function observeStream(
  stream: AsyncIterable<unknown>,
  done: (result: unknown) => void,
  failed: (error: unknown) => void,
): AsyncIterable<unknown> {
  const chunks: unknown[] = [];
  let settled = false;
  const settle = (outcome: { returned?: unknown } | { error: unknown }) => {
    if (settled) return;
    settled = true;
    if ("error" in outcome) failed(outcome.error);
    else done(outcome.returned === undefined ? chunks : { chunks, returned: outcome.returned });
  };
  const observe = (source: AsyncIterator<unknown>): AsyncIterator<unknown> => {
    const step = async (
      run: () => Promise<IteratorResult<unknown>>,
    ): Promise<IteratorResult<unknown>> => {
      try {
        const next = await run();
        if (next.done) settle({ returned: next.value });
        else chunks.push(next.value);
        return next;
      } catch (error) {
        settle({ error });
        throw error;
      }
    };
    return {
      next: (...args: [] | [unknown]) => step(() => source.next(...args)),
      // Stopped early: done with what was read, not the value passed back,
      // once cleanup has run; a cleanup that throws is the effect's error.
      return: async (value?: unknown) => {
        let result: IteratorResult<unknown>;
        try {
          result = source.return ? await source.return(value) : { done: true, value };
        } catch (error) {
          settle({ error });
          throw error;
        }
        if (result.done) settle({});
        else chunks.push(result.value);
        return result;
      },
      ...(source.throw && {
        throw: (error?: unknown) => step(() => source.throw!(error)),
      }),
    };
  };
  // A generator is its own iterator: its `next()` and `for await` share one.
  const self =
    typeof (stream as Partial<AsyncIterator<unknown>>).next === "function"
      ? observe(stream as unknown as AsyncIterator<unknown>)
      : undefined;
  const iterate = () => {
    try {
      // The iterator the stream supplies; the shared observer only when it is the stream itself.
      const iterator = stream[Symbol.asyncIterator]();
      return self && iterator === (stream as unknown) ? self : observe(iterator);
    } catch (error) {
      settle({ error });
      throw error;
    }
  };
  return new Proxy(stream, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return iterate;
      if (self && (property === "next" || property === "return" || property === "throw")) {
        return self[property];
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A deep copy the workflow owns: machine context is frozen in XState's dev
 * build, and legacy code mutates its input. Only plain data is copied:
 * `structuredClone` would turn a class instance into a plain object, so a
 * value holding one (or anything it cannot copy) passes as is.
 */
function ownCopy<T>(value: T): T {
  const hidden = { found: false };
  if (!isPlainData(value, new WeakSet(), hidden)) return value;
  // `structuredClone` drops symbol and non-enumerable keys; this copy keeps
  // them (a Map, Set, Date or typed array inside is shared).
  if (hidden.found) return contextCopy(value);
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * The input as machine context holds it: plain objects and arrays copied, so
 * XState's dev build, which deep-freezes them in context, never freezes the
 * caller's own. Everything else (class instances, functions, Maps) is shared,
 * and XState leaves those unfrozen.
 */
/** Each context copy of an input, to the input it was copied from. */
const copiedFrom = new WeakMap<object, unknown>();

function contextCopy<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  const proto: unknown = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && proto !== Object.prototype && proto !== null) return value;
  const copy: object = isArray ? [] : Object.create(proto as object | null);
  seen.set(value, copy);
  // Every own key, symbols and non-enumerable ones too, as defined.
  for (const key of Reflect.ownKeys(value)) {
    if (isArray && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ("value" in descriptor) descriptor.value = contextCopy(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  // Trailing holes: a sparse array's length is not implied by its entries.
  if (isArray) (copy as unknown[]).length = (value as unknown[]).length;
  return copy as T;
}

/** The input's context copy, remembered so the workflow gets the input itself back. */
function inputCopy<T>(input: T): T {
  const copy = contextCopy(input);
  if (copy !== input && typeof copy === "object" && copy !== null) copiedFrom.set(copy, input);
  return copy;
}

function isBuiltinView(value: ArrayBufferView): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === DataView.prototype) return true;
  const tag = (value as unknown as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
  const ctor = tag ? (globalThis as Record<string, unknown>)[tag] : undefined;
  return typeof ctor === "function" && proto === (ctor as { prototype: unknown }).prototype;
}

function isPlainData(value: unknown, seen: WeakSet<object>, hidden: { found: boolean }): boolean {
  if (typeof value === "function") return false;
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (value instanceof Date || value instanceof RegExp) return true;
  // A built-in typed array or DataView clones exactly; a subclass (Buffer) loses its prototype.
  if (ArrayBuffer.isView(value)) return isBuiltinView(value);
  if (value instanceof Map || value instanceof Set) {
    return [...value.entries()].every((entry) => entry.every((v) => isPlainData(v, seen, hidden)));
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
  // Symbol and non-enumerable keys (an array's `length` aside), which `structuredClone` drops.
  const extra = Reflect.ownKeys(value).length - Object.keys(value).length;
  if (extra !== (Array.isArray(value) ? 1 : 0)) hidden.found = true;
  return Reflect.ownKeys(value).every((key) => {
    if (Array.isArray(value) && key === "length") return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return !("value" in descriptor) || isPlainData(descriptor.value, seen, hidden);
  });
}

function workflowLogic<TInput, TOutput, TEffects>(
  run: (input: TInput, effects: TEffects, context: WorkflowRunContext) => PromiseLike<TOutput>,
  effects: TEffects,
  runSignal?: AbortSignal,
  redact?: Redact,
) {
  return createAsyncLogic<TOutput, TInput>({
    run: async ({ input: contextInput, self, signal }) => {
      // The input context was copied from, when this run copied it.
      const input = (
        typeof contextInput === "object" && contextInput !== null && copiedFrom.has(contextInput)
          ? copiedFrom.get(contextInput)
          : contextInput
      ) as TInput;
      // Sent to the invoking machine: under `runAgent` that lands in the
      // run's mailbox, so each one is a transition, a trace and a log entry.
      const parent = (self as unknown as { _parent?: { send(event: object): void } })._parent;
      // The run's own signal first, so the workflow sees its reason.
      const combined = runSignal ? AbortSignal.any([runSignal, signal]) : signal;
      return run(
        ownCopy(input),
        observeEffects(effects, (event) => parent?.send(event), combined, redact),
        { signal: combined },
      );
    },
  });
}

function createWrappedMachine<TInput, TOutput>(
  id: string,
  version: string,
  workflow: AnyActorLogic,
): WrappedWorkflowMachine<TInput, TOutput> {
  const agent = setupAgent({
    actors: { workflow },
    context: typeOnly<WrappedWorkflowContext<unknown, unknown>>(),
    input: typeOnly<unknown>(),
    output: typeOnly<unknown>(),
    events: {
      "effect.call": typeOnly<Omit<EffectCallEvent, "type">>(),
      "effect.done": typeOnly<Omit<EffectDoneEvent, "type">>(),
      "effect.error": typeOnly<Omit<EffectErrorEvent, "type">>(),
    },
  });
  type Context = WrappedWorkflowContext<unknown, unknown>;
  return agent.createMachine({
    id,
    version,
    context: ({ input }: { input: unknown }) => ({
      input: inputCopy(input),
      calls: 0,
      failures: 0,
    }),
    initial: "running",
    states: {
      running: {
        description: "The wrapped workflow runs as one black-box actor.",
        invoke: {
          src: "workflow",
          input: ({ context }: { context: Context }) => context.input,
          onDone: ({ output }: { output: unknown }) => ({ target: "done", context: { output } }),
        },
        on: {
          "effect.call": ({ context }: { context: Context }) => ({
            context: { calls: context.calls + 1 },
          }),
          "effect.done": () => ({}),
          "effect.error": ({ context }: { context: Context }) => ({
            context: { failures: context.failures + 1 },
          }),
        },
      },
      done: {
        type: "final",
        output: ({ context }: { context: Context }) => context.output,
      },
    },
  } as unknown as Parameters<typeof agent.createMachine>[0]) as unknown as WrappedWorkflowMachine<
    TInput,
    TOutput
  >;
}

/** The events a {@link wrapWorkflow} machine handles. */
export type WrappedWorkflowEvent = EffectCallEvent | EffectDoneEvent | EffectErrorEvent;

/** The machine {@link wrapWorkflow} returns. */
export type WrappedWorkflowMachine<TInput, TOutput> = PresetMachine<
  WrappedWorkflowContext<TInput, TOutput>,
  TInput,
  TOutput,
  WrappedWorkflowEvent
>;

/**
 * Wraps an existing async workflow, unchanged, as an agent machine: step 0 of
 * a strangler-fig retrofit. Pass every side effect it makes as `effects`; each
 * call becomes an `effect.call` event, then `effect.done` or `effect.error`, so
 * it shows up in transitions, traces, the event log and the inspector.
 *
 * What it buys today: inspection and traces of a workflow nobody rewrote, a
 * recorded baseline (`run(input, { recorder })`, or `checkParity` from
 * `@statelyai/agent/testing`), `signal` to abort it, and a seam to carve
 * phases out of, one at a time.
 *
 * What it does not: the workflow is a black box. The machine has one state
 * for all of it, so there is no resume in the middle of the function (a
 * resumed run starts it again), and `canReach` or `explorePaths` prove nothing
 * about what happens inside. Those arrive per phase, as phases move into
 * states. Effect arguments and results are journaled JSON-safe; values that
 * are not JSON lose what JSON cannot hold.
 *
 * @example
 * ```ts
 * const support = wrapWorkflow({
 *   id: "support",
 *   effects: { generate, lookupOrder, issueRefund },
 *   run: (input: Ticket, effects) => legacyRunTicket(input, effects),
 * });
 * const reply = await support.run(ticket); // what legacyRunTicket returned
 * ```
 */
export function wrapWorkflow<TInput, TOutput, TEffects extends WorkflowEffects<TEffects>>(
  config: WrapWorkflowConfig<TInput, TOutput, TEffects>,
): WrappedWorkflow<TInput, TOutput, TEffects> {
  const machine = createWrappedMachine<TInput, TOutput>(
    config.id,
    config.version ?? "1",
    workflowLogic(config.run, config.effects, undefined, config.redact),
  );
  return {
    machine,
    async run(input, options = {}) {
      const { effects: overrides, recorder, ...runOptions } = options;
      // A class instance's prototype methods count, bound to the instance.
      let effects = {
        ...mapEffects(config.effects, (_name, effect) => effect),
        ...(overrides ? mapEffects(overrides, (_name, effect) => effect) : {}),
      } as TEffects;
      if (recorder) {
        effects = mapEffects(effects, (name, effect) => recorder.fn(name, effect));
      }
      // The signal goes to the workflow, not the run: a drop-in keeps the
      // workflow's own abort behavior.
      const { signal: _signal, ...agentOptions } = runOptions;
      const result = await runAgent(machine, {
        ...agentOptions,
        input: input as never,
        actors: {
          workflow: workflowLogic(config.run, effects, options.signal, config.redact),
        },
      });
      if (result.status === "done") {
        const output = result.output as TOutput;
        recorder?.output(output);
        return output;
      }
      if (result.status === "error") throw result.error;
      throw new AgentError(
        "workflow-idle",
        `wrapWorkflow '${config.id}': the run settled idle, which a wrapped workflow never should.`,
      );
    },
  };
}
