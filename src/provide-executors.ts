import type { AnyActorLogic, AnyStateMachine } from "xstate";
import { isTextLogic, USER_INPUT_ACTOR, type AgentRequestExecutors } from "./text-logic.js";
import { isDecisionLogic, isPlanLogic } from "./decision.js";
import {
  bindDecisionForProvide,
  bindPlanForProvide,
  bindTextForProvide,
  getConfiguredInvokeSrcs,
  type AgentTraceEvent,
} from "./run-agent.js";
import { executorBoundLogics } from "./internal/registry.js";

/** Options for {@link provideExecutors}. */
export interface ProvideExecutorsOptions<TMachine extends AnyStateMachine = AnyStateMachine> {
  /**
   * Extra actor-source overrides merged onto the machine BEFORE binding — the
   * same shape as `machine.provide({ actorSources })`. Use it to supply the
   * `agent.userInput` handler, a custom non-agent actor, or to shadow an agent
   * source with your own executor-bound logic. Merged first, so an override
   * that already carries its own executor is left untouched by the binding pass.
   */
  actorSources?: Record<string, AnyActorLogic>;
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
 * Binding pass over `machine.implementations.actorSources` (after merging
 * `options.actorSources`):
 * - `mode: 'generate'` text source → `executors.generateText`
 * - `mode: 'stream'` text source → `executors.streamText`
 * - decision / `agent.decide` source → `executors.decide` (snapshot-driven
 *   candidate events, guard `canTake`, and auto-delivery of the chosen event,
 *   mirroring `runAgent` but without its model-call counting)
 * - `agent.plan` source → `executors.decide` (iterated, same semantics)
 *
 * Pass `options.onTrace` to observe request-level trace events (identical in
 * shape to `runAgent`'s); pair it with {@link traceTransitions} on the actor's
 * `inspect` to also capture `machine.transition` events in the same stream.
 *
 * A source that already carries its own executor (`.withExecutor(...)`) is left
 * as-is. `agent.userInput` is left UNBOUND — an uncontrolled host handles idle
 * itself, so supply a handler via `options.actorSources` if the machine uses it.
 * Non-agent actors are untouched.
 *
 * Throws at bind time if a source needs an executor kind that `executors` does
 * not provide.
 *
 * v1 does NOT descend into invoked child state machines: a string-keyed child
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
  const provided = (
    options.actorSources
      ? machine.provide({ actorSources: options.actorSources as never })
      : machine
  ) as TMachine;

  const effectiveSources = provided.implementations.actorSources as Record<string, AnyActorLogic>;
  const wrappedSources: Record<string, AnyActorLogic> = {};

  // The always-registered `agent.*` builtins are present in every machine even
  // when unused — so a missing executor is only an error when the machine
  // actually invokes that source. Un-invoked sources are left unbound.
  const invokedSrcs = getConfiguredInvokeSrcs(provided);

  for (const [key, logic] of Object.entries(effectiveSources)) {
    // Leave `agent.userInput` unbound: uncontrolled hosts drive human input
    // themselves (pass a handler via options.actorSources if needed).
    if (key === USER_INPUT_ACTOR) {
      continue;
    }

    if (isDecisionLogic(logic)) {
      // A decision that already carries its own executor runs itself.
      if (executorBoundLogics.has(logic as object)) {
        continue;
      }
      if (!executors.decide) {
        if (invokedSrcs.has(key)) {
          throw missingExecutorError(key, "decision", "decide");
        }
        continue;
      }
      wrappedSources[key] = bindDecisionForProvide(provided, logic, executors, bindOptions);
      continue;
    }

    if (isPlanLogic(logic)) {
      if (!executors.decide) {
        if (invokedSrcs.has(key)) {
          throw missingExecutorError(key, "plan", "decide");
        }
        continue;
      }
      wrappedSources[key] = bindPlanForProvide(provided, logic, executors, bindOptions);
      continue;
    }

    if (isTextLogic(logic)) {
      // A text source with its own bound executor (`.withExecutor(...)`) runs itself.
      if (executorBoundLogics.has(logic as object)) {
        continue;
      }
      const executor = logic.mode === "stream" ? executors.streamText : executors.generateText;
      if (!executor) {
        if (invokedSrcs.has(key)) {
          throw logic.mode === "stream"
            ? missingExecutorError(key, "streaming text", "streamText")
            : missingExecutorError(key, "text", "generateText");
        }
        continue;
      }
      wrappedSources[key] = bindTextForProvide(provided, logic, executors, bindOptions);
      continue;
    }

    // Invoked child state machines and non-agent actors pass through untouched.
  }

  return provided.provide({ actorSources: wrappedSources as never }) as TMachine;
}

function missingExecutorError(
  src: string,
  kind: "text" | "streaming text" | "decision" | "plan",
  executor: "generateText" | "streamText" | "decide",
): Error {
  return new Error(
    `provideExecutors: actor source '${src}' is a ${kind} source but no '${executor}' executor ` +
      "was provided. Add it to the executors object, or bind the source with its own executor " +
      "(logic.withExecutor(...)) before calling provideExecutors.",
  );
}
