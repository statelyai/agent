/**
 * Conformance: check a recorded run of existing code against a model of it.
 *
 * The model is an ordinary machine whose actors stand for the code's work.
 * `checkConformance` runs the model with every actor answered from the
 * recording: each one consumes the next observation of its kind. The first
 * time the model does something the recording does not show next, the run
 * stops and the step is reported. The code itself is not changed or run.
 */
import {
  createAsyncLogic,
  type AnyActorLogic,
  type AnyStateMachine,
  type ContextFrom,
  type EventObject,
  type InputFrom,
  type OutputFrom,
  type StateValue,
} from "xstate";
import { AgentError } from "./errors.js";
import { parseAgentEvent } from "./events.js";
import { isRecord } from "./internal/is-record.js";
import { getRegisteredAgentExecutionOptions } from "./internal/registry.js";
import { runAgent, type AgentRunOptions, type AgentTraceEvent } from "./run-agent.js";
import { isTextLogic } from "./text-logic.js";
import type { StandardSchemaV1 } from "./types.js";
import { isStandardSchema, validateSchemaSync } from "./utils.js";

/** One thing a recorded run did, as the model reads it. `kind` names what it is. */
export interface ConformanceObservation {
  kind: string;
}

/** What a {@link ConformanceActor} callback receives. */
export interface ConformanceActorArgs<
  TObservation extends ConformanceObservation,
  TInput = unknown,
  TConsumed = TObservation | undefined,
> {
  /** The actor's input, as the model computed it. Typed from the actor's input schema. */
  input: TInput;
  /**
   * The observation this actor consumed, of its `observes` kind, or
   * `undefined` for an actor with no `observes`.
   */
  observation: TConsumed;
  /** Every observation of the run, in order. */
  observations: readonly TObservation[];
  /** The index of the next observation not yet consumed. */
  index: number;
}

/** The observations of one kind. A union whose members do not narrow by `kind` is kept whole. */
export type ConformanceObservationOfKind<
  TObservation extends ConformanceObservation,
  TKind extends string,
> = [Extract<TObservation, { kind: TKind }>] extends [never]
  ? TObservation
  : Extract<TObservation, { kind: TKind }>;

interface ConformanceActorCallbacks<
  TObservation extends ConformanceObservation,
  TInput,
  TConsumed,
> {
  /** Return `false` when the actor's input does not fit the observation: an `input-mismatch` deviation. */
  matches?: (args: ConformanceActorArgs<TObservation, TInput, TConsumed>) => boolean;
  /**
   * The actor's output, which the model's `onDone` reads. Build it from the
   * observation, and from the model's own `input` for state the recording does
   * not show. A value the actor's output schema rejects is an `invalid-output`
   * deviation. Default: `undefined`.
   */
  output?: (args: ConformanceActorArgs<TObservation, TInput, TConsumed>) => unknown;
  /** Return a value to reject the actor with it, for work that failed in the recording. */
  error?: (args: ConformanceActorArgs<TObservation, TInput, TConsumed>) => unknown;
}

/**
 * How one of the model's actors is answered from the recording. `observes`
 * is the observation kind this actor consumes: when the model starts the
 * actor, the next observation must be of this kind, or the run deviates, and
 * the callbacks receive it narrowed to that kind. Omit it for work the
 * recording cannot see: the actor then consumes nothing and is listed in
 * {@link ConformanceReport.unobserved}.
 */
export type ConformanceActor<TObservation extends ConformanceObservation, TInput = unknown> =
  | {
      [TKind in TObservation["kind"]]: { observes: TKind } & ConformanceActorCallbacks<
        TObservation,
        TInput,
        ConformanceObservationOfKind<TObservation, TKind>
      >;
    }[TObservation["kind"]]
  | ({ observes?: undefined } & ConformanceActorCallbacks<TObservation, TInput, undefined>);

/** What a {@link ConformanceEvent} `matches` receives. */
export interface ConformanceEventArgs<
  TObservation extends ConformanceObservation,
  TContext = unknown,
> {
  /** The observation the event comes from. */
  observation: TObservation;
  /** The model's context while it waited for the event. */
  context: TContext;
  /** The model's state value while it waited for the event. */
  state: StateValue;
}

/**
 * How an observation becomes an event the idle model receives. A function is
 * the `event` alone. Add `matches` to compare the observation with what the
 * model holds, such as the draft a person approved against the draft in context.
 */
export type ConformanceEvent<TObservation extends ConformanceObservation, TContext = unknown> =
  | ((observation: TObservation) => EventObject)
  | {
      event: (observation: TObservation) => EventObject;
      /** Return `false` when the observation does not fit the model's state: an `input-mismatch` deviation. */
      matches?: (args: ConformanceEventArgs<TObservation, TContext>) => boolean;
    };

/**
 * How the code's recorded return value is checked against the model's output.
 * `observes` is the observation kind of the code's return value: when the
 * model finishes, the next observation must be of this kind, or the run
 * deviates.
 */
export type ConformanceOutput<TObservation extends ConformanceObservation, TOutput = unknown> = {
  [TKind in TObservation["kind"]]: {
    observes: TKind;
    /** Return `false` when the model's output does not fit the recorded one: an `output-mismatch` deviation. */
    matches?: (args: {
      output: TOutput;
      observation: ConformanceObservationOfKind<TObservation, TKind>;
    }) => boolean;
  };
}[TObservation["kind"]];

// The actor logic a machine declares per src; any src for an untyped machine.
type ActorMapOf<TMachine> = TMachine extends { _actorMap: infer TActorMap }
  ? TActorMap
  : Record<string, unknown>;

// The options as the check reads them, before narrowing by kind.
interface LooseActor<TObservation extends ConformanceObservation> {
  observes?: string;
  matches?: (args: ConformanceActorArgs<TObservation>) => boolean;
  output?: (args: ConformanceActorArgs<TObservation>) => unknown;
  error?: (args: ConformanceActorArgs<TObservation>) => unknown;
}
interface LooseOutput<TObservation extends ConformanceObservation> {
  observes: string;
  matches?: (args: { output: unknown; observation: TObservation }) => boolean;
}

/** Options for {@link checkConformance}. */
export interface CheckConformanceOptions<
  TMachine extends AnyStateMachine,
  TObservation extends ConformanceObservation,
> {
  /** The machine input for this run, validated as `runAgent` validates it. */
  input?: AgentRunOptions<TMachine>["input"];
  /** The recorded run, in order. Map a recording with `recording.effects.flatMap(...)`. */
  observations: readonly TObservation[];
  /**
   * One entry per actor source the model invokes, keyed by `src`. An invoked
   * src with no entry is an `unmapped-actor` deviation.
   */
  actors: NoInfer<{
    [TSrc in keyof ActorMapOf<TMachine> & string]?: ConformanceActor<
      TObservation,
      InputFrom<ActorMapOf<TMachine>[TSrc]>
    >;
  }>;
  /**
   * Observations the model receives as events, keyed by kind. When the model
   * settles idle and the next observation has one of these kinds, it is
   * consumed and sent, and the run resumes. An event whose payload the
   * machine's event schema rejects is an `invalid-event` deviation.
   */
  events?: NoInfer<{
    [TKind in TObservation["kind"]]?: ConformanceEvent<
      ConformanceObservationOfKind<TObservation, TKind>,
      ContextFrom<TMachine>
    >;
  }>;
  /**
   * Checks the code's return value. Map the recording's `output` effect to an
   * observation of kind `observes`: the model must finish there, and `matches`
   * compares its output with that observation. Without it, a recorded return
   * value is an `extra-observations` deviation like any other.
   */
  output?: NoInfer<ConformanceOutput<TObservation, OutputFrom<TMachine>>>;
}

/** Why a run deviated from the model. */
export type ConformanceDeviationReason =
  /** The model started an actor, and the next observation is of another kind. */
  | "unexpected-observation"
  /** The model started an actor that observes something, or finished with `output` set, and the recording had ended. */
  | "missing-observation"
  /** An actor's or event's `matches` returned `false` for the observation. */
  | "input-mismatch"
  /** An actor's `output` returned a value its declared output schema rejects. */
  | "invalid-output"
  /** An event built from an observation has a payload the machine's event schema rejects. */
  | "invalid-event"
  /** The model finished, and `output.matches` returned `false` for the recorded return value. */
  | "output-mismatch"
  /** The model finished or settled idle, and the recording continues. */
  | "extra-observations"
  /** The model was idle, and it does not handle the event an observation maps to in that state. */
  | "ignored-event"
  /** The model invoked a src with no entry in `actors`. */
  | "unmapped-actor";

/** The first point where the recorded run and the model part ways. */
export interface ConformanceDeviation<TObservation extends ConformanceObservation> {
  reason: ConformanceDeviationReason;
  /** The index of the observation at the deviation; `observations.length` when the recording had ended. */
  index: number;
  /** What the model did next: the actor src it started, the event, `"end of run"`, or `"idle, waiting for an event"`. */
  expected: string;
  /** What the recording shows next, or `undefined` when it had ended. */
  observed: TObservation | undefined;
  /** The model's state value at the deviation. */
  state: StateValue;
  /** The actor's input, for an actor deviation. */
  actorInput?: unknown;
  /** The schema's error message, for an `invalid-output` or `invalid-event` deviation. */
  schemaError?: string;
}

/** The result of {@link checkConformance}. */
export interface ConformanceReport<TObservation extends ConformanceObservation> {
  /** True when the model produced the recorded run exactly, observation for observation. */
  conforms: boolean;
  /** The first deviation, when the run does not conform. */
  deviation?: ConformanceDeviation<TObservation>;
  /** How many observations the model consumed. */
  consumed: number;
  /**
   * Actor srcs the model ran without an observation (no `observes`): what they
   * did was not checked against the recording.
   */
  unobserved: string[];
  /** How the model's run settled. A deviation stops the run, which then settles `error`. */
  status: "done" | "idle" | "error";
  /** The model's trace events. Pass the traces of several runs to `traceCoverage`. */
  trace: AgentTraceEvent[];
}

const NEVER = new Promise<never>(() => {});

// States whose invoke names its logic inline instead of by src: that logic
// would run for real, because only named sources can be swapped for answers.
function inlineInvokeStates(machine: AnyStateMachine): string[] {
  const found: string[] = [];
  const stack = [machine.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const invoke = (node.config as { invoke?: unknown }).invoke;
    const invokes = invoke === undefined ? [] : Array.isArray(invoke) ? invoke : [invoke];
    if (invokes.some((entry) => typeof (entry as { src?: unknown }).src !== "string")) {
      found.push(node.path.join(".") || "(root)");
    }
    stack.push(...Object.values(node.states));
  }
  return found.sort();
}

function actorLogics(machine: AnyStateMachine): Record<string, unknown> {
  return (
    (getRegisteredAgentExecutionOptions(machine).actors as Record<string, unknown> | undefined) ??
    (machine as { sources?: { actors?: Record<string, unknown> } }).sources?.actors ??
    {}
  );
}

function actorSources(machine: AnyStateMachine): string[] {
  return Object.keys(actorLogics(machine));
}

// The schema error for an actor output, or `undefined` when it fits. Async
// logic declares `schemas.output` for the whole output; text logic declares it
// for the `result` of its `{ result, messages }` output.
function outputSchemaError(logic: unknown, output: unknown): string | undefined {
  const check = (schema: unknown, value: unknown): string | undefined => {
    if (!isStandardSchema(schema)) return undefined;
    try {
      validateSchemaSync(schema as StandardSchemaV1, value);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  if (isTextLogic(logic)) {
    return isRecord(output) && "result" in output
      ? check(logic.schemas.output, output.result)
      : "expected text logic output { result, messages }";
  }
  return check(
    (logic as { config?: { schemas?: { output?: unknown } } }).config?.schemas?.output,
    output,
  );
}

// The event schemas a machine declares: the pack `setupAgent` registered, else
// a plain machine's own `schemas.events`.
function eventSchemasOf(machine: AnyStateMachine): Record<string, StandardSchemaV1> | undefined {
  return ((
    getRegisteredAgentExecutionOptions(machine).schemas as
      | { events?: Record<string, StandardSchemaV1> }
      | undefined
  )?.events ??
    (machine.schemas as { events?: Record<string, StandardSchemaV1> } | undefined)?.events) as
    | Record<string, StandardSchemaV1>
    | undefined;
}

/**
 * Checks a recorded run of existing code against a model of that code.
 *
 * The model runs with `runAgent`, and every actor in `actors` is answered from
 * `observations` instead of running: an actor with `observes` consumes the next
 * observation, which must be of that kind. The report names the first
 * deviation: where the model started something the recording does not show
 * next, or ended while the recording continued.
 *
 * Use it to verify existing code in place: prove the model's rules with
 * `canReach`, then check that recorded runs of the code conform to the model.
 * A conforming run shows the code behaved as the model allows on that run; it
 * does not prove the code can never break a rule.
 *
 * Every actor the model invokes must be declared by name: a model whose invoke
 * names logic inline throws `inline-actor-source`, because that logic would
 * run. A callback in `actors` that throws ends the check with
 * `conformance-callback-error` instead of counting as an actor failure.
 *
 * @example
 * ```ts
 * const report = await checkConformance(loopModel, {
 *   input: { maxIter: 3 },
 *   observations: recording.effects.flatMap(toObservation),
 *   actors: {
 *     route: { observes: "route", output: ({ observation }) => observation.names },
 *     runTurn: { observes: "turn", matches: ({ input, observation }) => input.name === observation.agent },
 *     save: {}, // not visible in this recording
 *   },
 * });
 * report.conforms; // false when the run did something the model does not allow
 * ```
 */
export async function checkConformance<
  TMachine extends AnyStateMachine,
  TObservation extends ConformanceObservation,
>(
  machine: TMachine,
  options: CheckConformanceOptions<TMachine, TObservation>,
): Promise<ConformanceReport<TObservation>> {
  const { observations } = options;
  const specs = options.actors as Record<string, LooseActor<TObservation> | undefined>;
  const events = (options.events ?? {}) as Record<
    string,
    ConformanceEvent<TObservation> | undefined
  >;
  const inline = inlineInvokeStates(machine);
  if (inline.length > 0) {
    throw new AgentError(
      "inline-actor-source",
      `checkConformance: ${inline.join(", ")} invoke${inline.length === 1 ? "s" : ""} inline actor logic, which would run for real. ` +
        "Declare each actor by name in setup ({ actors }) and invoke it by src, so the recording can answer it.",
    );
  }
  for (const src of Object.keys(specs)) {
    if (!actorSources(machine).includes(src)) {
      throw new AgentError(
        "unknown-actor-source",
        `checkConformance: actors.${src} names no actor source the machine declares (${actorSources(machine).join(", ") || "none"}).`,
      );
    }
  }

  let index = 0;
  let deviation: ConformanceDeviation<TObservation> | undefined;
  // A callback that throws is a bug in the check, not a modeled failure.
  let callbackError: AgentError | undefined;
  let state: StateValue = machine.config.initial as StateValue;
  const unobserved = new Set<string>();
  const trace: AgentTraceEvent[] = [];
  const controller = new AbortController();

  const callbackFailure = (name: string, cause: unknown) =>
    new AgentError(
      "conformance-callback-error",
      `checkConformance: ${name} threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  // For callbacks outside an actor, where the check can throw directly.
  const callback = <T>(name: string, fn: () => T): T => {
    try {
      return fn();
    } catch (cause) {
      throw callbackFailure(name, cause);
    }
  };

  const deviate = (
    reason: ConformanceDeviationReason,
    expected: string,
    actorInput?: unknown,
    schemaError?: string,
  ): Promise<never> => {
    deviation ??= {
      reason,
      index,
      expected,
      observed: observations[index],
      state,
      ...(actorInput !== undefined ? { actorInput } : {}),
      ...(schemaError !== undefined ? { schemaError } : {}),
    };
    controller.abort();
    return NEVER;
  };

  const logics = actorLogics(machine);
  const answer = (src: string, spec: LooseActor<TObservation> | undefined): AnyActorLogic =>
    createAsyncLogic({
      run: async ({ input }: { input: unknown }) => {
        if (deviation || callbackError) return NEVER;
        if (!spec) return deviate("unmapped-actor", src, input);
        let observation: TObservation | undefined;
        if (spec.observes === undefined) {
          unobserved.add(src);
        } else {
          const next = observations[index];
          if (next === undefined) return deviate("missing-observation", src, input);
          if (next.kind !== spec.observes) return deviate("unexpected-observation", src, input);
          observation = next;
          index += 1;
        }
        const args = { input, observation, observations, index };
        const call = <T>(name: "matches" | "error" | "output", fn: () => T): T | typeof NEVER => {
          try {
            return fn();
          } catch (cause) {
            callbackError ??= callbackFailure(`actors.${src}.${name}`, cause);
            controller.abort();
            return NEVER;
          }
        };
        if (spec.matches) {
          const fits = call("matches", () => spec.matches!(args));
          if (fits === NEVER) return NEVER;
          if (!fits) {
            index -= observation ? 1 : 0;
            return deviate("input-mismatch", src, input);
          }
        }
        const error = call("error", () => spec.error?.(args));
        if (error === NEVER) return NEVER;
        if (error !== undefined) throw error;
        const output = call("output", () => spec.output?.(args));
        if (output === NEVER) return NEVER;
        const schemaError = outputSchemaError(logics[src], output);
        if (schemaError !== undefined) {
          index -= observation ? 1 : 0;
          return deviate("invalid-output", src, input, schemaError);
        }
        return output;
      },
    });

  const actors = Object.fromEntries(
    actorSources(machine).map((src) => [src, answer(src, specs[src])]),
  );
  const shared = {
    actors,
    signal: controller.signal,
    onTrace: (event: AgentTraceEvent) => trace.push(event),
    onTransition: (snapshot: { value: StateValue }) => {
      state = snapshot.value;
    },
  } as unknown as AgentRunOptions<TMachine>;

  let result = await runAgent(machine, {
    ...shared,
    ...(options.input !== undefined ? { input: options.input } : {}),
  } as AgentRunOptions<TMachine>);
  while (!deviation && !callbackError && result.status === "idle") {
    const next = observations[index];
    const entry = next === undefined ? undefined : events[next.kind];
    if (!entry || next === undefined) break;
    const { event: toEvent, matches } = typeof entry === "function" ? { event: entry } : entry;
    const fits = callback(`events.${next.kind}.matches`, () =>
      matches
        ? matches({
            observation: next,
            context: (result.snapshot as { context?: unknown }).context,
            state,
          })
        : true,
    );
    if (!fits) {
      deviation = {
        reason: "input-mismatch",
        index,
        expected: `event ${next.kind}`,
        observed: next,
        state,
      };
      break;
    }
    const event = callback(`events.${next.kind}`, () => toEvent(next));
    try {
      parseAgentEvent(machine, event, { events: eventSchemasOf(machine) });
    } catch (error) {
      deviation = {
        reason: "invalid-event",
        index,
        expected: `event ${next.kind}`,
        observed: next,
        state,
        schemaError: error instanceof Error ? error.message : String(error),
      };
      break;
    }
    // Consumed before the run: actors the event starts read the next observation.
    index += 1;
    result = await runAgent(machine, {
      ...shared,
      snapshot: result.persist(),
      event,
    } as AgentRunOptions<TMachine>);
    if (result.ignored !== undefined) {
      index -= 1;
      deviation = {
        reason: "ignored-event",
        index,
        expected: `an event ${JSON.stringify(state)} handles`,
        observed: next,
        state,
      };
      break;
    }
  }

  if (callbackError) throw callbackError;
  const outputSpec = options.output as LooseOutput<TObservation> | undefined;
  const last = observations[index];
  if (!deviation && outputSpec && result.status === "done" && last === undefined) {
    deviation = {
      reason: "missing-observation",
      index,
      expected: `output (${outputSpec.observes})`,
      observed: undefined,
      state,
    };
  } else if (
    !deviation &&
    outputSpec &&
    result.status === "done" &&
    last?.kind === outputSpec.observes
  ) {
    const output = result.output;
    const fits = callback("output.matches", () =>
      outputSpec.matches ? outputSpec.matches({ output, observation: last }) : true,
    );
    if (fits) index += 1;
    else {
      deviation = {
        reason: "output-mismatch",
        index,
        expected: `output ${JSON.stringify(output)}`,
        observed: last,
        state,
      };
    }
  }
  if (!deviation && index < observations.length) {
    deviation = {
      reason: "extra-observations",
      index,
      expected: result.status === "idle" ? "idle, waiting for an event" : "end of run",
      observed: observations[index],
      state,
    };
  }
  return {
    conforms: deviation === undefined,
    ...(deviation ? { deviation } : {}),
    consumed: index,
    unobserved: [...unobserved],
    status: result.status,
    trace,
  };
}
