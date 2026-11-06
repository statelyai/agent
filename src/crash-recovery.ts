/**
 * `checkCrashRecovery` — kills a durable run at every point it could die,
 * resumes it from its log, and checks the resumed run against an
 * uninterrupted one.
 * @module
 */
import type {
  AnyActorLogic,
  AnyActorRef,
  AnyStateMachine,
  EventFromLogic,
  EventObject,
} from "xstate";
import { isActLogic } from "./act.js";
import { isDecisionLogic } from "./decision.js";
import { stableStringify } from "./equivalence.js";
import { agentCallSite, canonicalEventJson, replay, type AgentLogEntry } from "./event-log.js";
import { createInMemoryEventLogStore, type AgentEventLogStore } from "./event-log-store.js";
import {
  createAgentRuntime,
  isStateMachineLogic,
  runToQuiescence,
  toJsonValue,
  type AgentRunResult,
  type AgentRuntimeOptions,
} from "./run-agent.js";
import { isTextLogic, type AgentRequestExecutors } from "./text-logic.js";

/** Options for {@link checkCrashRecovery}. */
export interface CheckCrashRecoveryOptions<TMachine extends AnyStateMachine> {
  /** Machine input for the run. */
  input?: unknown;
  /**
   * Host events, delivered one per turn: each time the run settles `idle`,
   * the next one resumes it. The run ends when it settles `done` or `error`,
   * or `idle` with none left.
   */
  events?: readonly EventFromLogic<TMachine>[];
  /**
   * Model executors. Each call is recorded by its `callKey`. They run in the
   * uninterrupted run only: after a crash, a call it made gets its recorded
   * answer, so a fake may answer by call order.
   */
  executors?: Partial<AgentRequestExecutors>;
  /** Actor sources, as `createAgentRuntime`'s `actors`. */
  actors?: Record<string, AnyActorLogic>;
  /**
   * A fresh, empty store for one run: the baseline, or one crash and its
   * resume. Default: an in-memory store. Pass your own adapter to check that
   * an entry it acknowledged is read back after the crash.
   */
  store?: () => AgentEventLogStore;
  /** Called before every run (the baseline and each crash), to reset fakes the executors or actors keep. */
  reset?: () => void;
  /** Other runtime options (`maxModelCalls`, `verification`, …), shared by every run. */
  runtime?: Omit<
    AgentRuntimeOptions<TMachine>,
    "executors" | "actors" | "store" | "threadId" | "signal" | "timers" | "abortWith"
  >;
  /** Milliseconds one run (the baseline, a crashed run, or its resume) may take. Default 5000. */
  timeout?: number;
}

/**
 * One effect the run started: a model call (keyed by its `callKey` without the
 * execution id, which differs per run) or a plain actor (keyed by its invoke
 * site, as `actor:<site>`).
 */
export interface CrashEffect {
  kind: "model" | "actor";
  key: string;
}

/** Where a run was killed. */
export type CrashPoint =
  | {
      /** After the store accepted `entries` entries: the next append never lands. */
      kind: "log";
      entries: number;
    }
  | {
      /** While `effect` was in flight: it ran, but its result was never recorded. */
      kind: "effect";
      effect: CrashEffect;
      /** The effect's position among the baseline's effects, from 0. */
      index: number;
      /** Which run of `effect.key` it is, from 0: the run dies at that one, whatever order concurrent effects start in. */
      occurrence: number;
    };

/** What went wrong after a crash. */
export type CrashRecoveryProblem =
  /** An effect whose completion was durable ran again. */
  | "reran"
  /** An effect the uninterrupted run made never ran. */
  | "skipped"
  /** An effect ran that the uninterrupted run never made (a model call under a new key). */
  | "unexpected"
  /** A model call re-executed under its key with a different request. */
  | "request-changed"
  /** The resumed run ended with a different status, output, state, or context. */
  | "outcome"
  /** The final log does not replay to the resumed run's state. */
  | "replay"
  /** The crashed run or its resume never settled within `timeout`. */
  | "stuck"
  /** The crashed run, its resume, or the store factory threw. */
  | "threw";

/** One problem at one crash point. */
export interface CrashRecoveryFailure {
  point: CrashPoint;
  problem: CrashRecoveryProblem;
  message: string;
  /** The effect key, for effect problems. */
  key?: string;
}

/** What {@link checkCrashRecovery} found. */
export interface CrashRecoveryReport {
  /** True when every crash point recovered. */
  ok: boolean;
  /** The uninterrupted run. */
  baseline: {
    status: AgentRunResult<AnyStateMachine>["status"];
    output?: unknown;
    /** Entries in its log. */
    entries: number;
    /** Effects it started, in start order. */
    effects: CrashEffect[];
  };
  /** Every point a run was killed at, in order. */
  points: CrashPoint[];
  /**
   * Points no run died at, with why: the crashed run never started that
   * effect, or one write took the log past that length. Their resumes were
   * not checked.
   */
  unreached: Array<{ point: CrashPoint; reason: string }>;
  failures: CrashRecoveryFailure[];
}

class CrashError extends Error {
  constructor() {
    super("checkCrashRecovery: simulated crash");
    this.name = "CrashError";
  }
}

const DONE_ACTOR = "xstate.done.actor";
const ERROR_ACTOR = "xstate.error.actor";

type RecordedAnswer = { result: unknown; ms: number };

type StartedEffect = CrashEffect & { site: string; completed: boolean; request?: string };

/** One run's effects and how it decides to crash. */
interface RunWorld {
  effects: StartedEffect[];
  /** The log entry ids of the host events this run delivered, in order. */
  hostEntries: string[];
  /** Each model call's result and how long it took, by key. */
  answers: Map<string, RecordedAnswer>;
  /** The uninterrupted run's answers: a call it made gets the same result again. */
  recorded?: ReadonlyMap<string, RecordedAnswer>;
  /** Called as each effect starts; returns true when the run crashes there. */
  onEffect(effect: StartedEffect): boolean;
  crashed: boolean;
}

/**
 * Runs `machine` once uninterrupted, then once per crash point: killed after
 * each log append and while each effect is in flight, then resumed from the
 * store's log by a fresh runtime. Each resumed run is checked against the
 * uninterrupted one:
 *
 * - An effect whose completion was durable before the crash never runs again.
 *   Only an effect in flight at the crash may (execution is at-least-once).
 * - Every effect of the uninterrupted run runs, and no other: a re-executed
 *   model call keeps its `callKey` and its request.
 * - The run ends with the same status, output, state value, and context.
 * - The resumed log replays to that state.
 *
 * Model calls the uninterrupted run made are answered from its recording.
 * Plain actors run live, so they must give the same result however many times
 * they run (pass `reset` for fakes that keep state).
 */
export async function checkCrashRecovery<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: CheckCrashRecoveryOptions<TMachine> = {},
): Promise<CrashRecoveryReport> {
  const timeout = options.timeout ?? 5000;

  // ─── Baseline ───
  options.reset?.();
  const baselineWorld = newWorld(() => false);
  const newStore = options.store ?? createInMemoryEventLogStore;
  const baselineStore = observedStore(newStore(), baselineWorld, () => false);
  const baseline = await withTimeout(
    runTurns(machine, options, baselineWorld, baselineStore.store),
    timeout,
  );
  if (baseline === TIMED_OUT) {
    throw new Error(`checkCrashRecovery: the uninterrupted run did not settle within ${timeout}ms`);
  }
  const baselineEntries = await baselineStore.store.read(THREAD);
  const baselineCounts = countBy(baselineWorld.effects);
  const expected = outcomeOf(baseline);

  const points: CrashPoint[] = [];
  // Before the first append, and after each one.
  for (const entries of new Set([0, ...baselineStore.appends])) {
    points.push({ kind: "log", entries });
  }
  const seen = new Map<string, number>();
  baselineWorld.effects.forEach((effect, index) => {
    const occurrence = seen.get(effect.key) ?? 0;
    seen.set(effect.key, occurrence + 1);
    points.push({
      kind: "effect",
      effect: { kind: effect.kind, key: effect.key },
      index,
      occurrence,
    });
  });

  const failures: CrashRecoveryFailure[] = [];
  const unreached: CrashRecoveryReport["unreached"] = [];
  for (const point of points) {
    const found = await crashAt(point, {
      machine,
      options,
      timeout,
      baselineCounts,
      recorded: baselineWorld.answers,
      expected,
    });
    if (Array.isArray(found)) failures.push(...found);
    else unreached.push({ point, reason: found.unreached });
  }

  return {
    ok: failures.length === 0,
    baseline: {
      status: baseline.status,
      ...(baseline.status === "done" ? { output: baseline.output } : {}),
      entries: baselineEntries.length,
      effects: baselineWorld.effects.map(({ kind, key }) => ({ kind, key })),
    },
    points,
    unreached,
    failures,
  };
}

const THREAD = "crash-recovery";
const TIMED_OUT = Symbol("timed out");

interface CrashContext<TMachine extends AnyStateMachine> {
  machine: TMachine;
  options: CheckCrashRecoveryOptions<TMachine>;
  timeout: number;
  baselineCounts: Map<string, number>;
  recorded: ReadonlyMap<string, RecordedAnswer>;
  expected: string;
}

async function crashAt<TMachine extends AnyStateMachine>(
  point: CrashPoint,
  ctx: CrashContext<TMachine>,
): Promise<CrashRecoveryFailure[] | { unreached: string }> {
  const { machine, options, timeout } = ctx;
  const fail = (problem: CrashRecoveryProblem, message: string, key?: string) => ({
    point,
    problem,
    message,
    ...(key !== undefined ? { key } : {}),
  });
  options.reset?.();
  let backing: AgentEventLogStore;
  try {
    backing = (options.store ?? createInMemoryEventLogStore)();
  } catch (error) {
    return [fail("threw", `the store factory threw: ${String(error)}`)];
  }

  // ─── The run that dies ───
  const controller = new AbortController();
  let runs = 0;
  const crashed = newWorld(
    (effect) =>
      point.kind === "effect" && effect.key === point.effect.key && runs++ === point.occurrence,
    ctx.recorded,
  );
  const crash = () => {
    if (crashed.crashed) return;
    crashed.crashed = true;
    controller.abort(new CrashError());
  };
  // Why the run did not die at the point, if it did not.
  let missed: string | undefined =
    point.kind === "log" && point.entries === 0
      ? undefined
      : point.kind === "log"
        ? "the log never reached that length"
        : "the run never started that effect";
  const onEffect = crashed.onEffect;
  crashed.onEffect = (effect) => {
    const dies = onEffect(effect);
    if (dies) {
      missed = undefined;
      // The effect has started; the process dies before its result is recorded.
      queueMicrotask(crash);
    }
    return dies;
  };
  const dying = observedStore(backing, crashed, (accepted) => {
    if (point.kind !== "log" || accepted < point.entries) return false;
    missed =
      accepted === point.entries ? undefined : `one write took the log to ${accepted} entries`;
    crash();
    return true;
  });
  if (point.kind === "log" && point.entries === 0) dying.freeze();
  let died: AgentRunResult<TMachine> | typeof TIMED_OUT | undefined;
  try {
    died = await withTimeout(
      runTurns(machine, options, crashed, dying.store, undefined, controller.signal),
      timeout,
    );
  } catch (error) {
    // Dying is the point; anything else thrown is a finding.
    if (!(error instanceof CrashError)) {
      crash();
      return [fail("threw", `the crashed run threw: ${String(error)}`)];
    }
  }
  crash();
  if (died === TIMED_OUT) {
    return [fail("stuck", `the run did not stop within ${timeout}ms after the crash`)];
  }
  if (missed !== undefined) {
    return { unreached: missed };
  }

  // ─── The resume ───
  const resumed = newWorld(() => false, ctx.recorded);
  const resumeController = new AbortController();
  let result: AgentRunResult<TMachine> | typeof TIMED_OUT;
  try {
    result = await withTimeout(
      runTurns(machine, options, resumed, backing, crashed.hostEntries, resumeController.signal),
      timeout,
    );
  } catch (error) {
    return [fail("threw", `the resume threw: ${String(error)}`)];
  }
  if (result === TIMED_OUT) {
    // Stop it, so nothing it still runs touches the next point's fakes.
    resumed.crashed = true;
    resumeController.abort(new CrashError());
    return [fail("stuck", `the resume did not settle within ${timeout}ms`)];
  }

  const failures: CrashRecoveryFailure[] = [];

  // Effects: every baseline effect ran, nothing else ran, and only what was
  // in flight at the crash ran twice.
  const total = countBy([...crashed.effects, ...resumed.effects]);
  const inFlight = countBy(crashed.effects.filter((effect) => !effect.completed));
  for (const [key, count] of total) {
    const expected = ctx.baselineCounts.get(key) ?? 0;
    const allowed = expected + (inFlight.get(key) ?? 0);
    if (expected === 0) {
      failures.push(
        fail("unexpected", `'${key}' ran ${count}x; the uninterrupted run never made it`, key),
      );
    } else if (count > allowed) {
      failures.push(
        fail(
          "reran",
          `'${key}' ran ${count}x, at most ${allowed} expected: its completion was durable before the crash`,
          key,
        ),
      );
    }
  }
  for (const [key, expected] of ctx.baselineCounts) {
    const count = total.get(key) ?? 0;
    if (count < expected) {
      failures.push(fail("skipped", `'${key}' ran ${count}x, ${expected} expected`, key));
    }
  }
  const crashedRequests = new Map(
    crashed.effects
      .filter((effect) => effect.kind === "model")
      .map((effect) => [effect.key, effect.request]),
  );
  for (const effect of resumed.effects) {
    if (effect.kind !== "model" || !crashedRequests.has(effect.key)) continue;
    const before = crashedRequests.get(effect.key);
    // A request that cannot be fingerprinted is not compared.
    if (before === undefined || effect.request === undefined) continue;
    if (before !== effect.request) {
      failures.push(
        fail("request-changed", `'${effect.key}' re-executed with a different request`, effect.key),
      );
    }
  }

  const actual = outcomeOf(result);
  if (actual !== ctx.expected) {
    failures.push(fail("outcome", `resumed run ended ${actual}, expected ${ctx.expected}`));
  }

  const log = await backing.read(THREAD);
  try {
    const replayed = replay(
      options.actors !== undefined
        ? (machine.provide({ actors: options.actors as never }) as TMachine)
        : machine,
      log,
    );
    const fromLog = stableStringify(
      toJsonValue({
        value: (replayed.snapshot as { value?: unknown }).value,
        context: (replayed.snapshot as { context?: unknown }).context,
      }),
    );
    const live = stableStringify(
      toJsonValue({
        value: (result.snapshot as { value?: unknown }).value,
        context: (result.snapshot as { context?: unknown }).context,
      }),
    );
    if (fromLog !== live) {
      failures.push(
        fail("replay", `the log replays to ${fromLog}, the resumed run ended at ${live}`),
      );
    }
  } catch (error) {
    failures.push(fail("replay", `the log does not replay: ${String(error)}`));
  }

  return failures;
}

/**
 * Runs the turns: start from `input`, then one host event per idle settle.
 * Resuming, the events already in the log are skipped.
 */
async function runTurns<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: CheckCrashRecoveryOptions<TMachine>,
  world: RunWorld,
  store: AgentEventLogStore,
  /** Resuming: the host events the crashed run delivered, by entry id. */
  deliveredBefore?: readonly string[],
  signal?: AbortSignal,
): Promise<AgentRunResult<TMachine>> {
  const tracked = trackActors(machine, world);
  const executors = trackExecutors(options.executors ?? {}, world);
  const actors =
    options.actors !== undefined
      ? Object.fromEntries(
          Object.entries(options.actors).map(([key, logic]) => [
            key,
            isStateMachineLogic(logic) ? trackActors(logic, world) : trackLogic(logic, world),
          ]),
        )
      : undefined;
  const turn = (event?: EventObject) => {
    // The host's event is the first root entry like it after the run opens.
    let awaiting = event !== undefined ? canonicalEventJson(event) : undefined;
    return runToQuiescence(
      createAgentRuntime(tracked, {
        ...options.runtime,
        onEvent: (entry) => {
          options.runtime?.onEvent?.(entry);
          if (
            awaiting !== undefined &&
            entry.actorPath === undefined &&
            canonicalEventJson(entry.event) === awaiting
          ) {
            world.hostEntries.push(entry.id);
            awaiting = undefined;
          }
        },
        executors,
        ...(actors !== undefined ? { actors } : {}),
        store,
        threadId: THREAD,
        ...(signal !== undefined ? { signal } : {}),
      }),
      {
        ...(options.input !== undefined ? { input: options.input as never } : {}),
        ...(event !== undefined ? { event: event as never } : {}),
      },
    );
  };

  const events = options.events ?? [];
  let next = 0;
  if (deliveredBefore !== undefined) {
    const durable = new Set((await store.read(THREAD)).map((entry) => entry.id));
    while (next < deliveredBefore.length && durable.has(deliveredBefore[next]!)) next++;
  }
  let result = await turn();
  while (result.status === "idle" && next < events.length && !world.crashed) {
    result = await turn(events[next++]);
    await result.drain?.();
  }
  await result.drain?.();
  return result;
}

function newWorld(
  crashesAt: (effect: StartedEffect) => boolean,
  recorded?: ReadonlyMap<string, RecordedAnswer>,
): RunWorld {
  return {
    effects: [],
    hostEntries: [],
    answers: new Map(),
    ...(recorded !== undefined ? { recorded } : {}),
    crashed: false,
    onEffect: (effect) => crashesAt(effect),
  };
}

/**
 * `store`, recording each append's resulting length and marking the effects
 * whose completion an accepted entry carries. `afterAppend` returns true to
 * freeze it: every later append rejects, as if the process died.
 */
function observedStore(
  store: AgentEventLogStore,
  world: RunWorld,
  afterAppend: (accepted: number) => boolean,
) {
  const appends: number[] = [];
  let frozen = false;
  const observed: AgentEventLogStore = {
    ...store,
    read: (threadId, options) => store.read(threadId, options),
    length: (threadId) => store.length(threadId),
    fork: (input) => store.fork(input),
    async append(input) {
      if (frozen || world.crashed) throw new CrashError();
      await store.append(input);
      for (const entry of input.entries) markCompleted(entry, world.effects);
      const accepted = input.expectedIndex + input.entries.length;
      appends.push(accepted);
      if (afterAppend(accepted)) frozen = true;
    },
  };
  return {
    store: observed,
    appends,
    freeze: () => {
      frozen = true;
    },
  };
}

/**
 * Marks the call an accepted entry completes: a decision's chosen event names
 * its call (`site#n`); a completion completes the oldest open effect at its
 * invoke site, with the other attempts of the same model call.
 */
function markCompleted(entry: AgentLogEntry, effects: StartedEffect[]): void {
  if (entry.decidedBy !== undefined) {
    const call = entry.decidedBy;
    for (const effect of effects) {
      if (effect.key === call || effect.key.startsWith(`${call}.`)) effect.completed = true;
    }
    return;
  }
  if (entry.event.type !== DONE_ACTOR && entry.event.type !== ERROR_ACTOR) return;
  const actorId = (entry.event as { actorId?: unknown }).actorId;
  if (typeof actorId !== "string") return;
  const site = agentCallSite(entry.actorPath ?? [], actorId);
  const oldest = effects.find((effect) => effect.site === site && !effect.completed);
  if (oldest === undefined) return;
  const call = oldest.kind === "model" ? callOfModelKey(oldest.key) : undefined;
  for (const effect of effects) {
    if (
      effect === oldest ||
      (call !== undefined && effect.site === site && callOfModelKey(effect.key) === call)
    ) {
      effect.completed = true;
    }
  }
}

function countBy(effects: readonly CrashEffect[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { key } of effects) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function outcomeOf(result: AgentRunResult<AnyStateMachine>): string {
  const snapshot = result.snapshot as { value?: unknown; context?: unknown };
  return stableStringify(
    toJsonValue({
      status: result.status,
      ...(result.status === "done" ? { output: result.output } : {}),
      ...(result.status === "error" ? { cause: result.cause } : {}),
      value: snapshot.value,
      context: snapshot.context,
    }),
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Effect tracking ───

/** `callKey` without its execution id: the same call has the same key in every run. */
function modelKey(callKey: string): string {
  return callKey.slice(callKey.indexOf(":") + 1);
}

function siteOfModelKey(key: string): string {
  const hash = key.lastIndexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

/** `site#n` of a model key: the call, without its attempt or strategy suffix. */
function callOfModelKey(key: string): string {
  const hash = key.lastIndexOf("#");
  if (hash === -1) return key;
  const dot = key.indexOf(".", hash);
  return dot === -1 ? key : key.slice(0, dot);
}

function trackExecutors(
  executors: Partial<AgentRequestExecutors>,
  world: RunWorld,
): Partial<AgentRequestExecutors> {
  const tracked: Record<string, unknown> = {};
  for (const [slot, executor] of Object.entries(executors)) {
    if (typeof executor !== "function") continue;
    tracked[slot] = async (request: unknown, info?: { callKey?: string; signal?: AbortSignal }) => {
      if (world.crashed) return never(info?.signal);
      const key = info?.callKey !== undefined ? modelKey(info.callKey) : `${slot}:?`;
      const effect: StartedEffect = {
        kind: "model",
        key,
        site: siteOfModelKey(key),
        completed: false,
        request: requestFingerprint(request),
      };
      world.effects.push(effect);
      const dies = world.onEffect(effect);
      const recorded = world.recorded?.get(key);
      let result: unknown;
      if (recorded !== undefined) {
        // As long as it took the first time, so concurrent calls settle in
        // the same order.
        await new Promise((resolve) => setTimeout(resolve, recorded.ms));
        result = recorded.result;
      } else {
        const started = Date.now();
        result = await (executor as (...args: unknown[]) => unknown)(request, info);
        if (info?.callKey !== undefined) {
          world.answers.set(key, { result, ms: Date.now() - started });
        }
      }
      // Died while the call was out: it ran, but its result never comes back.
      if (dies || world.crashed) return never(info?.signal);
      return result;
    };
  }
  return tracked as Partial<AgentRequestExecutors>;
}

// Fields that name the run, not the request.
const VOLATILE_REQUEST_KEYS = new Set(["runId"]);

function requestFingerprint(request: unknown): string | undefined {
  try {
    const json = toJsonValue(request);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      for (const key of VOLATILE_REQUEST_KEYS) delete (json as Record<string, unknown>)[key];
    }
    return stableStringify(json);
  } catch {
    return undefined;
  }
}

function never(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** `machine` with every plain actor source, at any depth, tracked. */
function trackActors<TMachine extends AnyStateMachine>(
  machine: TMachine,
  world: RunWorld,
  // The machines above this one: a machine that invokes itself stops here,
  // while the same machine under two sources is tracked under both.
  ancestors: ReadonlySet<AnyStateMachine> = new Set(),
): TMachine {
  if (ancestors.has(machine)) return machine;
  const visited = new Set([...ancestors, machine]);
  const sources = (machine.sources?.actors ?? {}) as Record<string, AnyActorLogic>;
  const wrapped: Record<string, AnyActorLogic> = {};
  for (const [key, logic] of Object.entries(sources)) {
    if (isTextLogic(logic) || isDecisionLogic(logic) || isActLogic(logic)) continue;
    if (isStateMachineLogic(logic)) {
      const inner = trackActors(logic, world, visited);
      if (inner !== logic) wrapped[key] = inner;
      continue;
    }
    if (typeof logic?.transition === "function") wrapped[key] = trackLogic(logic, world);
  }
  return Object.keys(wrapped).length > 0
    ? (machine.provide({ actors: wrapped as never }) as TMachine)
    : machine;
}

type ActorSelf = AnyActorRef & { id?: string; _parent?: ActorSelf };

/** The invoke site of an actor: its path's last id, under its parents' path. */
function actorSite(self: ActorSelf): string {
  const path: string[] = [];
  for (let at: ActorSelf | undefined = self; at?._parent !== undefined; at = at._parent) {
    path.unshift(String(at.id));
  }
  return agentCallSite(path.slice(0, -1), path.at(-1) ?? "");
}

/**
 * `logic`, recording each effect it starts (`@xstate.effect`: an async
 * actor's run, a callback's body). After the crash, effects do not start.
 */
function trackLogic(logic: AnyActorLogic, world: RunWorld): AnyActorLogic {
  if (isTextLogic(logic) || isDecisionLogic(logic) || isActLogic(logic)) return logic;
  type Result = [unknown, unknown[]];
  type Effect = { type?: string; exec: (...args: unknown[]) => unknown };
  const track = (result: Result, self: ActorSelf): Result => {
    const [snapshot, effects] = result;
    if (!Array.isArray(effects) || !effects.some((e) => (e as Effect)?.type === "@xstate.effect")) {
      return result;
    }
    return [
      snapshot,
      effects.map((effect) => {
        if ((effect as Effect)?.type !== "@xstate.effect") return effect;
        const exec = (effect as Effect).exec;
        const tracked = (...args: unknown[]) => {
          if (world.crashed) return;
          const site = actorSite(self);
          const started: StartedEffect = {
            kind: "actor",
            key: `actor:${site}`,
            site,
            completed: false,
          };
          world.effects.push(started);
          world.onEffect(started);
          return exec(...args);
        };
        return { ...(effect as object), exec: tracked, action: tracked };
      }),
    ];
  };
  const overrides: PropertyDescriptorMap = {
    transition: {
      value: (...args: Parameters<AnyActorLogic["transition"]>) =>
        track(logic.transition(...args) as unknown as Result, args[2].self as ActorSelf),
    },
  };
  if (typeof logic.initialTransition === "function") {
    overrides["initialTransition"] = {
      value: (...args: Parameters<NonNullable<AnyActorLogic["initialTransition"]>>) =>
        track(logic.initialTransition!(...args) as unknown as Result, args[1]!.self as ActorSelf),
    };
  }
  if (typeof logic.start === "function") {
    // A restored actor restarts its effects from `start`, through its own
    // `transition`, not this one: track what it hands the executor.
    overrides["start"] = {
      value: (
        snapshot: unknown,
        scope: { actionExecutor: (effect: unknown) => void; self: AnyActorRef },
        startOptions: unknown,
      ) =>
        logic.start!(
          snapshot as never,
          new Proxy(scope, {
            get(target, property) {
              if (property === "actionExecutor") {
                return (effect: unknown) => {
                  const [, [tracked]] = track([undefined, [effect]], target.self as ActorSelf);
                  target.actionExecutor(tracked);
                };
              }
              return Reflect.get(target, property, target);
            },
          }) as never,
          startOptions as never,
        ),
    };
  }
  return Object.create(logic, overrides) as AnyActorLogic;
}
