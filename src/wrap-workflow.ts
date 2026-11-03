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
   * traces, and to {@link Recorder} recordings.
   */
  run: (input: TInput, effects: TEffects, context: WorkflowRunContext) => PromiseLike<TOutput>;
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
  /** The resolved value, JSON-safe (`null` for `undefined`). */
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
   * or rethrows what it threw (the same error object). An aborted run throws
   * `signal.reason`.
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

type AnyEffect = (...args: unknown[]) => PromiseLike<unknown>;

/** Wraps each effect so its call and settlement reach the machine as events. */
function observeEffects<TEffects>(effects: TEffects, send: (event: object) => void): TEffects {
  let calls = 0;
  return Object.fromEntries(
    Object.entries(effects as Record<string, unknown>).map(([name, effect]) => {
      if (typeof effect !== "function") return [name, effect];
      const observed = async (...args: unknown[]) => {
        const call = calls++;
        send({ type: "effect.call", name, call, args: (toJsonValue(args) ?? []) as JsonValue[] });
        try {
          const result = await (effect as AnyEffect)(...args);
          send({ type: "effect.done", name, call, result: toJsonValue(result) ?? null });
          return result;
        } catch (error) {
          send({ type: "effect.error", name, call, error: toJsonValue(error) ?? null });
          throw error;
        }
      };
      return [name, observed];
    }),
  ) as TEffects;
}

function workflowLogic<TInput, TOutput, TEffects>(
  run: (input: TInput, effects: TEffects, context: WorkflowRunContext) => PromiseLike<TOutput>,
  effects: TEffects,
  runSignal?: AbortSignal,
) {
  return createAsyncLogic<TOutput, TInput>({
    run: async ({ input, self, signal }) => {
      // Sent to the invoking machine: under `runAgent` that lands in the
      // run's mailbox, so each one is a transition, a trace and a log entry.
      const parent = (self as unknown as { _parent?: { send(event: object): void } })._parent;
      return run(
        input,
        observeEffects(effects, (event) => parent?.send(event)),
        {
          // The run's own signal first, so the workflow sees its reason.
          signal: runSignal ? AbortSignal.any([runSignal, signal]) : signal,
        },
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
    context: ({ input }: { input: unknown }) => ({ input, calls: 0, failures: 0 }),
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
    workflowLogic(config.run, config.effects),
  );
  return {
    machine,
    async run(input, options = {}) {
      const { effects: overrides, recorder, ...runOptions } = options;
      let effects = { ...config.effects, ...overrides } as TEffects;
      if (recorder) {
        effects = Object.fromEntries(
          Object.entries(effects as Record<string, unknown>).map(([name, effect]) => [
            name,
            typeof effect === "function" ? recorder.fn(name, effect as AnyEffect) : effect,
          ]),
        ) as TEffects;
      }
      const result = await runAgent(machine, {
        ...runOptions,
        input: input as never,
        actors: { workflow: workflowLogic(config.run, effects, options.signal) },
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
