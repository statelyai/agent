import type { AnyActorLogic, AnyStateMachine } from "xstate";
import { isTextLogic, USER_INPUT_ACTOR, type AgentRequestExecutors } from "./text-logic.js";
import { isDecisionLogic } from "./decision.js";
import {
  bindDecisionForProvide,
  bindTextForProvide,
  getConfiguredInvokeSrcs,
  type AgentTraceEvent,
} from "./run-agent.js";
import { executorBoundLogics } from "./internal/registry.js";

/** Options for {@link provideExecutors}. */
export interface ProvideExecutorsOptions<TMachine extends AnyStateMachine = AnyStateMachine> {
  /**
   * Extra actor-source overrides merged onto the machine BEFORE binding — the
   * same shape as `machine.provide({ actors })`. Use it to supply the
   * `agent.userInput` handler, a custom non-agent actor, or to shadow an agent
   * source with your own executor-bound logic. Merged first, so an override
   * that already carries its own executor is left untouched by the binding pass.
   */
  actors?: Record<string, AnyActorLogic>;
  /** Chunk sink threaded to every bound `mode: 'stream'` text source. */
  onChunk?: (chunk: string) => void;
  /**
   * A single ordered stream of request-level trace events
   * (`request.start`/`request.end`/`request.error`/`stream.chunk`) with the
   * SAME versioned envelope {@link runAgent} emits. Because one bound machine can
   * back many concurrent root actors, envelope state (`runId`, monotonic `seq`)
   * is minted per ROOT actor at runtime — two concurrent actors get distinct
   * `runId`s and independent `seq`. Pair with {@link traceTransitions} on the
   * actor's `inspect` to fold `machine.transition` events into the same stream.
   * Unlike `runAgent` there are NO `run.start`/`run.end` events (no run
   * boundary).
   */
  onTrace?: (event: AgentTraceEvent<TMachine>) => void;
}

/**
 * Binds a machine's agent actor sources to a set of host `executors` in one
 * call, returning a `machine.provide(...)`-ed copy ready for a plain
 * `createActor(...)` — the uncontrolled-mode counterpart to {@link runAgent}.
 * No run loop, no idle settling: the returned machine drives itself, so
 *
 * ```ts
 * const actor = createActor(provideExecutors(machine, { generateText, decide }), { input });
 * actor.start();
 * ```
 *
 * behaves like a normal XState actor whose agent invokes now reach real models.
 *
 * Binding pass over `machine.sources.actors` (after merging
 * `options.actors`):
 * - `mode: 'generate'` text source → `executors.generateText`
 * - `mode: 'stream'` text source → `executors.streamText`
 * - decision / `agent.decide` source → `executors.decide` (snapshot-driven
 *   candidate events, guard `canTake`, and auto-delivery of the chosen event,
 *   mirroring `runAgent` but without its model-call counting)
 *
 * Pass `options.onTrace` to observe request-level trace events (identical in
 * shape to `runAgent`'s); pair it with {@link traceTransitions} on the actor's
 * `inspect` to also capture `machine.transition` events in the same stream.
 *
 * A source that already carries its own executor (`.withExecutor(...)`) is left
 * as-is. `agent.userInput` is left UNBOUND — an uncontrolled host handles idle
 * itself, so supply a handler via `options.actors` if the machine uses it.
 * Non-agent actors are untouched.
 *
 * Throws at bind time if a source needs an executor kind that `executors` does
 * not provide.
 *
 * `provideExecutors` does not descend into invoked child state machines: a string-keyed child
 * machine source is left untouched, so a child with its own agent invokes needs
 * its own `provideExecutors(...)` (or `runAgent`, which does rebind children).
 */
export function provideExecutors<TMachine extends AnyStateMachine>(
  machine: TMachine,
  executors: AgentRequestExecutors,
  options: ProvideExecutorsOptions<TMachine> = {},
): TMachine {
  const bindOptions = {
    onChunk: options.onChunk,
    onTrace: options.onTrace as ((event: AgentTraceEvent) => void) | undefined,
  };
  const withActors = (target: TMachine, actors: Record<string, AnyActorLogic>): TMachine =>
    target.provide({ actors: actors as never }) as TMachine;

  const provided = options.actors ? withActors(machine, options.actors) : machine;

  const effectiveSources = provided.sources.actors as Record<string, AnyActorLogic>;
  const wrappedSources: Record<string, AnyActorLogic> = {};

  // The always-registered `agent.*` builtins are present in every machine even
  // when unused — so a missing executor is only an error when the machine
  // actually invokes that source. Un-invoked sources are left unbound.
  const invokedSrcs = getConfiguredInvokeSrcs(provided);

  for (const [key, logic] of Object.entries(effectiveSources)) {
    // Leave `agent.userInput` unbound: uncontrolled hosts drive human input
    // themselves (pass a handler via options.actors if needed).
    if (key === USER_INPUT_ACTOR) {
      continue;
    }

    let binding: MissingExecutorBinding | undefined;
    if (isDecisionLogic(logic)) {
      binding = {
        executorKey: "decide",
        kind: "decision",
        bind: () => bindDecisionForProvide(provided, logic, executors, bindOptions),
      };
    } else if (isTextLogic(logic)) {
      const streaming = logic.mode === "stream";
      binding = {
        executorKey: streaming ? "streamText" : "generateText",
        kind: streaming ? "streaming text" : "text",
        bind: () => bindTextForProvide(provided, logic, executors, bindOptions),
      };
    }
    // Invoked child state machines and non-agent actors pass through untouched.
    if (!binding) {
      continue;
    }
    // A source that already carries its own executor (`.withExecutor(...)`) runs itself.
    if (executorBoundLogics.has(logic)) {
      continue;
    }
    if (!executors[binding.executorKey]) {
      if (invokedSrcs.has(key)) {
        throw missingExecutorError(key, binding.kind, binding.executorKey);
      }
      continue;
    }
    wrappedSources[key] = binding.bind();
  }

  return withActors(provided, wrappedSources);
}

/** What one agent source needs: the executor slot, its label, and how to bind it. */
interface MissingExecutorBinding {
  executorKey: "generateText" | "streamText" | "decide";
  kind: "text" | "streaming text" | "decision";
  bind: () => AnyActorLogic;
}

function missingExecutorError(
  src: string,
  kind: "text" | "streaming text" | "decision",
  executor: "generateText" | "streamText" | "decide",
): Error {
  return new Error(
    `provideExecutors: actor source '${src}' is a ${kind} source but no '${executor}' executor ` +
      "was provided. Add it to the executors object, or bind the source with its own executor " +
      "(logic.withExecutor(...)) before calling provideExecutors.",
  );
}
