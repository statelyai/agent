import type { AnyActorLogic, AnyActorRef, AnyStateMachine } from "xstate";
import {
  isTextLogic,
  USER_INPUT_ACTOR,
  type AgentRequestExecutorInfo,
  type AgentRequestExecutors,
} from "./text-logic.js";
import { isDecisionLogic } from "./decision.js";
import {
  bindChildMachineForProvide,
  bindDecisionForProvide,
  bindTextForProvide,
  getConfiguredInvokeSrcs,
  isStateMachineLogic,
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
  /**
   * Mints the per-call idempotency key threaded to executors as
   * `info.callKey`. `runAgent` owns a log and mints the key itself; the
   * uncontrolled path has no log, so a host that HAS one (notably
   * {@link runDurableAgent}, which keys against its journal) supplies the
   * minter here and gets the same `${logId}:${siteId}#${occurrence}` key on
   * every bound text and decision call. `siteId` is the call's durable invoke
   * id (the same value `info.requestId` carries); returning `undefined` leaves
   * `info.callKey` unset. Omit the option and `info.callKey` is always
   * undefined, as before.
   *
   * Called ONCE per invoked actor: repeated executor attempts for one invoke
   * (a decision retry) reuse that invoke's first key rather than consuming a
   * new occurrence, and concurrent actors never share a memo. One bound
   * machine can back many root actors, though, and they all draw from the
   * minter you pass — occurrences at a shared site therefore interleave across
   * actors. Supply a minter that folds in your own lineage id (as
   * {@link runDurableAgent} folds in its journal's `executionId`) when keys
   * must be unique per actor.
   *
   * `self` is accepted for signature parity with `runAgent`'s minter and is
   * never passed on this path — the key is minted at the executor seam, which
   * sees `info`, not the invoked leaf actor.
   */
  callKey?: (siteId: string, self?: AnyActorRef) => string | undefined;
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
 * Executor inheritance is RECURSIVE, exactly as in `runAgent`: a string-keyed
 * invoked child machine is rebound too, so its own text/decision requests — at
 * any depth — reach the same host executors. A direct-object invoke `src`
 * cannot be swapped via `.provide`, so nothing under one inherits; bind those
 * with `.withExecutor(...)` or register the child as a string-keyed source. A
 * source that already carries its own executor is never overwritten.
 */
export function provideExecutors<TMachine extends AnyStateMachine>(
  machine: TMachine,
  rawExecutors: AgentRequestExecutors,
  options: ProvideExecutorsOptions<TMachine> = {},
): TMachine {
  // Key minting wraps the host executors themselves, so every bound call —
  // top level or inside a recursively rebound child machine — carries
  // `info.callKey` alongside the `requestId` the binder already sets.
  const executors = options.callKey ? withCallKeys(rawExecutors, options.callKey) : rawExecutors;
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

    // An invoked child machine: recursively bind ITS agent sources with the
    // same executors (same semantics as runAgent's rebindChildMachine).
    if (isStateMachineLogic(logic)) {
      // Assert BEFORE binding: a child's own invoked text/decision sources
      // need the same executors, and a missing one must fail here rather than
      // when the child actor eventually starts.
      if (invokedSrcs.has(key)) {
        assertChildBindable(logic, executors, key, new Set([provided as AnyStateMachine]));
      }
      const rebound = bindChildMachineForProvide(
        logic,
        executors,
        bindOptions,
        new Set([provided as AnyStateMachine]),
      );
      if (rebound !== logic) {
        wrappedSources[key] = rebound;
      }
      continue;
    }

    // Non-agent actors pass through untouched.
    const requirement = executorRequirementOf(logic);
    if (!requirement) {
      continue;
    }
    const binding: MissingExecutorBinding = {
      ...requirement,
      bind: () =>
        isDecisionLogic(logic)
          ? bindDecisionForProvide(provided, logic, executors, bindOptions)
          : bindTextForProvide(provided, logic as never, executors, bindOptions),
    };
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

/**
 * Wraps each provided executor so it receives `info.callKey`, minted once per
 * INVOKED ACTOR from `info.requestId` (the durable invoke id = the call's site
 * id).
 *
 * A decision RETRY calls the same executor again for ONE invoke (the retry
 * loop grows `request.attempts` and re-enters), which must not consume a new
 * occurrence — the mirror of `runAgent` memoizing its key per invoked leaf
 * actor. The seam never sees that actor's `self`, but it does see the actor's
 * own `info.signal`: xstate mints one `AbortSignal` per invoked actor run, and
 * `resolveDecision` threads the SAME one through every attempt, so it
 * identifies the invoke exactly. Memoizing on it (per bound machine, in a
 * WeakMap) is therefore per-actor.
 *
 * Site-keyed memoization would NOT be: one bound machine can back many
 * concurrent root actors, and two of them invoking the same site would hand
 * each other's retries the wrong key.
 */
function withCallKeys(
  executors: AgentRequestExecutors,
  mintCallKey: (siteId: string, self?: AnyActorRef) => string | undefined,
): AgentRequestExecutors {
  const keyByInvoke = new WeakMap<AbortSignal, string>();
  const keyFor = (info: AgentRequestExecutorInfo | undefined) => {
    const siteId = info?.requestId;
    // Nothing to key against without a site id, and a key already on `info`
    // (a host that minted its own) is never overwritten.
    if (siteId === undefined || info?.callKey !== undefined) {
      return undefined;
    }
    const invoke = info?.signal;
    if (invoke) {
      const memoized = keyByInvoke.get(invoke);
      if (memoized !== undefined) {
        return memoized;
      }
    }
    const key = mintCallKey(siteId);
    // No signal (an executor driven outside an invoked actor) means no invoke
    // identity to memoize against: mint per call.
    if (key !== undefined && invoke) {
      keyByInvoke.set(invoke, key);
    }
    return key;
  };
  const withKey = (
    info: AgentRequestExecutorInfo | undefined,
    key: string | undefined,
  ): AgentRequestExecutorInfo | undefined =>
    key === undefined ? info : { ...(info ?? {}), callKey: key };

  const { generateText, streamText, decide } = executors;
  return {
    ...(generateText
      ? { generateText: (request, info) => generateText(request, withKey(info, keyFor(info))) }
      : {}),
    ...(streamText
      ? { streamText: (request, info) => streamText(request, withKey(info, keyFor(info))) }
      : {}),
    ...(decide ? { decide: (request, info) => decide(request, withKey(info, keyFor(info))) } : {}),
  };
}

/** The executor slot + label an agent logic needs, or `undefined` for a non-agent actor. */
function executorRequirementOf(logic: AnyActorLogic):
  | {
      executorKey: "generateText" | "streamText" | "decide";
      kind: "text" | "streaming text" | "decision";
    }
  | undefined {
  if (isDecisionLogic(logic)) {
    return { executorKey: "decide", kind: "decision" };
  }
  if (isTextLogic(logic)) {
    return logic.mode === "stream"
      ? { executorKey: "streamText", kind: "streaming text" }
      : { executorKey: "generateText", kind: "text" };
  }
  return undefined;
}

/**
 * Walks an invoked child machine's own invoked sources (recursively, at any
 * depth) and throws the same missing-executor error `provideExecutors` throws
 * for the top-level machine — before any actor starts. Mirrors runAgent's
 * `assertBindable` for the uncontrolled path. Cycle-safe via `visited`.
 */
function assertChildBindable(
  childMachine: AnyStateMachine,
  executors: AgentRequestExecutors,
  path: string,
  visited: Set<AnyStateMachine>,
): void {
  if (visited.has(childMachine)) {
    return;
  }
  const nextVisited = new Set([...visited, childMachine]);
  const sources = childMachine.sources.actors as Record<string, AnyActorLogic>;
  for (const src of getConfiguredInvokeSrcs(childMachine)) {
    if (src === USER_INPUT_ACTOR) {
      continue;
    }
    const logic = sources[src];
    if (!logic) {
      continue;
    }
    if (isStateMachineLogic(logic)) {
      assertChildBindable(logic, executors, `${path} > ${src}`, nextVisited);
      continue;
    }
    const requirement = executorRequirementOf(logic);
    if (!requirement || executorBoundLogics.has(logic)) {
      continue;
    }
    if (!executors[requirement.executorKey]) {
      throw missingExecutorError(`${path} > ${src}`, requirement.kind, requirement.executorKey);
    }
  }
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
