/**
 * Seam runs — score ONE model call of a machine agent in isolation, while
 * still running the whole machine end to end.
 *
 * An end-to-end score tells you a run got worse; it does not tell you WHICH
 * call got worse. A machine agent is a chain of calls, and each one is a seam.
 * {@link runSeam} runs the real machine with every request routed to a scripted
 * answer except one: the seam under test gets a `candidate` executor (the real
 * model, a candidate prompt, a fine-tune) or stays scripted for a keyless run.
 * Everything after the seam is a real consequence of it — the branch it took,
 * the states it reached, the events the user then sent — so the slice of the
 * run after the seam is the score.
 *
 * Dependency-free and keyless by default, like the rest of the verification
 * family: {@link runSeam} returns trajectory slices ready for
 * `matchesTrajectory`, and the scorers stay yours.
 *
 * @module
 */
import type {
  AnyMachineSnapshot,
  AnyStateMachine,
  EventFromLogic,
  InputFrom,
  Snapshot,
  SnapshotFrom,
  StateValue,
} from "xstate";
import { AgentError } from "./errors.js";
import type { AgentLogEntry } from "./event-log-store.js";
import { normalizeGeneratorResult } from "./text-logic.js";
import { runAgent } from "./run-agent.js";
import type { RunAgentOptions, RunAgentResult } from "./run-agent.js";
import { resolveScriptedTextEntry } from "./scripted-executors.js";
import type { ScriptedTextEntry } from "./scripted-executors.js";
import type {
  AgentExecutorTextRequest,
  AgentRequestExecutorInfo,
  AgentRequestExecutorResult,
  AgentRequestExecutors,
  AgentTextRequest,
} from "./text-logic.js";
import type { AgentTools } from "./types.js";
import { getStateMeta } from "./utils.js";

/**
 * Which model call is under test: the Nth call addressed either by request
 * `name` (the `setupAgent({ requests })` key or `createTextLogic({ name })`,
 * the better developer handle) or by `model` key (the `defineModels` key) for
 * requests that carry no name.
 */
export type SeamRef =
  | {
      /** The request's registered `name`. */
      request: string;
      model?: undefined;
      /** 0-based occurrence among the calls matching this key. Default `0`. */
      occurrence?: number;
    }
  | {
      /** The `defineModels` key the request names. */
      model: string;
      request?: undefined;
      /** 0-based occurrence among the calls matching this key. Default `0`. */
      occurrence?: number;
    };

/**
 * One idle pause, handed to {@link RunSeamOptions.respond} so the simulated
 * user answers off the machine's own state rather than a fixed transcript — a
 * live seam may branch differently, and a reactive policy scores that run
 * instead of crashing on it.
 */
export interface SeamTurn<TMachine extends AnyStateMachine> {
  /** The idle snapshot to answer. */
  snapshot: SnapshotFrom<TMachine>;
  /** Its state value, for a `switch` on flat machines. */
  state: StateValue;
  /** The merged `meta` of the active state(s) — e.g. a declared `interaction`. */
  meta: Record<string, unknown>;
  /** 0-based index of this pause within the run. */
  turn: number;
  /** The `idle` result that produced the pause. */
  result: RunAgentResult<TMachine>;
}

/** One side of the seam: a trajectory pair ready for `matchesTrajectory`. */
export interface SeamSlice {
  /** State values entered on this side of the seam, in order. */
  statePath: StateValue[];
  /** Replayable log entries on this side of the seam, in order. */
  events: AgentLogEntry[];
}

/** Options for {@link runSeam}. */
export interface RunSeamOptions<TMachine extends AnyStateMachine> {
  /** Machine input, passed straight through to `runAgent`. */
  input?: InputFrom<TMachine>;
  /**
   * The call plan: scripted answers per key, consumed in order. A key is a
   * request `name` when one is scripted under it, else a `model` key, so a
   * machine whose requests are named routes by name and an unnamed one routes
   * by model.
   *
   * Entries follow {@link ScriptedTextEntry} conventions (a value, an
   * `{ output, usage? }` envelope, or a function of the request). The LAST
   * entry of a queue repeats, so a live seam that sends the run down a longer
   * branch still finds an answer instead of running dry.
   */
  scripts?: Record<string, ScriptedTextEntry[]>;
  /** The call under test. */
  seam: SeamRef;
  /**
   * The executor for the seam — the real model, a candidate prompt, anything
   * request-shaped. Omit to run the seam scripted too: the whole seam run is
   * then keyless and deterministic.
   */
  candidate?: AgentRequestExecutors["generateText"];
  /**
   * The simulated user. Called at every idle pause; return the event to send,
   * or `null`/`undefined` to stop the run there. Omitted, the run stops at the
   * first idle pause.
   */
  respond?: (turn: SeamTurn<TMachine>) => EventFromLogic<TMachine> | null | undefined;
  /** Maximum idle pauses to answer before stopping. Default `12`. */
  maxTurns?: number;
  /**
   * Base executors merged UNDER the seam routing — supply `decide` (e.g. from
   * `createScriptedExecutors({ decisions })`) for a machine that also decides.
   * Text slots are always owned by the routing.
   */
  executors?: Partial<AgentRequestExecutors>;
  /** Passed through to `runAgent`: the deterministic idle-state predicate. */
  isSuspended?: RunAgentOptions<TMachine>["isSuspended"];
  /** Passed through to `runAgent`: actor implementations merged onto the machine. */
  actors?: RunAgentOptions<TMachine>["actors"];
}

/** What {@link runSeam} returns: the seam's own answer, plus the run it caused. */
export interface RunSeamResult<TMachine extends AnyStateMachine> {
  /**
   * The final `runAgent` result. Its `events` are the WHOLE run's log (every
   * leg's entries), while `usage` accounts only for the last leg.
   */
  result: RunAgentResult<TMachine>;
  /** What the seam call returned, or `undefined` when the run never reached it. */
  seamOutput: unknown;
  /** Model calls made before the seam, or `-1` when the run never reached it. */
  callsBeforeSeam: number;
  /** Everything up to the seam's own effect completion. */
  before: SeamSlice;
  /**
   * Everything from the seam's own effect completion onward — the branch the
   * seam caused, and the score. Empty when the run never reached the seam.
   */
  after: SeamSlice;
}

/** Thrown when the call plan runs dry on a request that is not the live seam. */
class SeamScriptError extends AgentError {
  constructor(message: string) {
    super("seam-script-exhausted", message);
    this.name = "SeamScriptError";
  }
}

function seamKeyOf(seam: SeamRef): string {
  return seam.request ?? seam.model;
}

function describeRequest(request: AgentTextRequest): string {
  return request.name
    ? `'${request.name}' (model '${request.model}')`
    : `(model '${request.model}')`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Whatever a host executor may return — our envelope, or a raw AI SDK result. */
type ExecutorReturn = Awaited<ReturnType<NonNullable<AgentRequestExecutors["generateText"]>>>;

/**
 * The seam's own answer, for scoring. Our `{ output }` envelope is read
 * directly; a raw AI SDK `generateText` result contributes its `text`. A raw
 * STREAM result is left alone — the machine consumes that stream, and reading
 * it here would steal the chunks — so `seamOutput` is `undefined` for a
 * streaming candidate that returns one. Score its trajectory instead.
 * @internal
 */
async function seamOutputOf(result: ExecutorReturn, request: AgentTextRequest): Promise<unknown> {
  if (!isRecord(result)) {
    return undefined;
  }
  if ("output" in result) {
    return await result["output"];
  }
  if ("textStream" in result) {
    return undefined;
  }
  // Raw AI SDK generate result: the same unwrap (and structured-output parse)
  // the machine itself will perform.
  return await normalizeGeneratorResult(result, `seam '${request.name ?? request.model}'`, {
    request,
  });
}

/**
 * Runs a machine end to end with one model call under test, and slices the run
 * at that call.
 *
 * The `before`/`after` slices are the point: `after.statePath` is the branch
 * the seam chose and `after.events` is the same question against the durable
 * log, both ready for `matchesTrajectory`. The state slice splits where the
 * state path stood when the seam answered; the event slice splits at the
 * seam's own effect completion (the first `xstate.done.*`/`xstate.error.*`
 * entry appended after the call was made).
 *
 * @example Keyless: the seam is scripted too, so the whole thing runs offline.
 * ```ts
 * const run = await runSeam(emailDrafter, {
 *   scripts: { promptEvaluator: [vague, complete], emailDrafter: [draft] },
 *   seam: { request: 'evaluatePrompt' },
 *   respond: ({ state }) => (state === 'prompting' ? { type: 'PROMPT_SUBMITTED', prompt } : null),
 * });
 *
 * matchesTrajectory(run.after.statePath, ['needsMoreInfo', 'drafting']);
 * ```
 *
 * @example A candidate prompt at the seam, scored against the same rows.
 * ```ts
 * const { generateText } = createAiSdkExecutors({ models });
 * const run = await runSeam(emailDrafter, { ...row, candidate: generateText });
 * ```
 */
export async function runSeam<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunSeamOptions<TMachine>,
): Promise<RunSeamResult<TMachine>> {
  const { seam, candidate } = options;
  const queues = new Map<string, ScriptedTextEntry[]>(
    Object.entries(options.scripts ?? {}).map(([key, answers]) => [key, [...answers]]),
  );
  const statePath: StateValue[] = [];

  let calls = 0;
  let seamMatches = 0;
  let seamOutput: unknown;
  let seamReached = false;
  let callsBeforeSeam = -1;
  let seamStateAt = 0;
  let seamEventAt = 0;
  let liveEvents = 0;

  const scriptedAnswer = async (
    request: AgentTextRequest,
    info: AgentRequestExecutorInfo | undefined,
    optional: boolean,
  ): Promise<AgentRequestExecutorResult | undefined> => {
    const key =
      request.name !== undefined && queues.has(request.name) ? request.name : request.model;
    const queue = queues.get(key);
    if (!queue?.length) {
      if (optional) {
        return undefined;
      }
      throw new SeamScriptError(
        `runSeam: no scripted answer left for request ${describeRequest(request)}. Add an entry ` +
          `to \`scripts.${key}\` — its last entry repeats, so one extra answer covers a ` +
          "longer branch.",
      );
    }
    // The last entry repeats: a live seam that branches further still finds an
    // answer instead of running dry.
    const entry = queue.length === 1 ? queue[0]! : queue.shift()!;
    return resolveScriptedTextEntry(entry, request, info);
  };

  const route = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<ExecutorReturn> => {
    const callIndex = calls++;
    const keyMatches =
      seam.request !== undefined ? request.name === seam.request : request.model === seam.model;
    const isSeam = keyMatches && seamMatches++ === (seam.occurrence ?? 0);

    // The script is the whole call plan, so the seam consumes its slot too: the
    // candidate REPLACES that answer rather than skipping it, and every later
    // scripted answer stays lined up with the plan.
    const scripted = await scriptedAnswer(request, info, isSeam && candidate !== undefined);
    if (!isSeam) {
      return scripted!;
    }

    seamReached = true;
    callsBeforeSeam = callIndex;
    seamStateAt = statePath.length;
    seamEventAt = liveEvents;

    if (!candidate) {
      if (!scripted) {
        throw new SeamScriptError(
          `runSeam: the seam '${seamKeyOf(seam)}' has no candidate and no scripted answer. ` +
            "Pass `candidate`, or script the seam's key.",
        );
      }
      seamOutput = scripted.output;
      return scripted;
    }

    const result = await candidate(request as AgentExecutorTextRequest, info);
    seamOutput = await seamOutputOf(result, request);
    return result;
  };

  const executors: Partial<AgentRequestExecutors> = {
    ...options.executors,
    generateText: route,
    streamText: async (request, info) => {
      const result = await route(request, info);
      // Stream semantics with no model: the whole text lands as one chunk.
      const output = isRecord(result) ? result["output"] : undefined;
      if (typeof output === "string") {
        info?.onChunk?.(output);
      }
      return result;
    },
  };

  let snapshot: Snapshot<unknown> | undefined;
  let event: EventFromLogic<TMachine> | undefined;
  let events: AgentLogEntry[] = [];
  let result!: RunAgentResult<TMachine>;
  const maxTurns = options.maxTurns ?? 12;

  for (let turn = 0; turn <= maxTurns; turn++) {
    result = await runAgent(machine, {
      ...(snapshot ? { snapshot } : { input: options.input as InputFrom<TMachine> }),
      ...(event ? { event } : {}),
      ...(options.isSuspended ? { isSuspended: options.isSuspended } : {}),
      ...(options.actors ? { actors: options.actors } : {}),
      events,
      executors,
      onEvent: () => {
        liveEvents++;
      },
      onTransition: (next, causedBy) => {
        // A resumed leg re-emits the state it restored into under
        // `@xstate.init`. That is an artifact of the leg structure this helper
        // owns, not a machine transition, so the path stays the machine's.
        if (turn > 0 && causedBy.type === "@xstate.init") {
          return;
        }
        statePath.push((next as AnyMachineSnapshot).value);
      },
    });

    events = result.events;
    // Resync: the settled log is the source of truth for the next leg's offset.
    liveEvents = events.length;

    if (result.status !== "idle" || turn === maxTurns) {
      break;
    }

    const next = options.respond?.({
      snapshot: result.snapshot,
      state: (result.snapshot as AnyMachineSnapshot).value,
      meta: getStateMeta<SnapshotFrom<TMachine>, Record<string, unknown>>(result.snapshot),
      turn,
      result,
    });
    if (!next) {
      break;
    }
    event = next;
    snapshot = result.snapshot;
  }

  // The seam's own effect completion opens the `after` slice.
  let splitAt = events.length;
  if (seamReached) {
    splitAt = seamEventAt;
    for (let index = seamEventAt; index < events.length; index++) {
      const type = events[index]!.event.type;
      if (type.startsWith("xstate.done") || type.startsWith("xstate.error")) {
        splitAt = index;
        break;
      }
    }
  }
  const splitStateAt = seamReached ? seamStateAt : statePath.length;

  return {
    result,
    seamOutput,
    callsBeforeSeam,
    before: { statePath: statePath.slice(0, splitStateAt), events: events.slice(0, splitAt) },
    after: { statePath: statePath.slice(splitStateAt), events: events.slice(splitAt) },
  };
}
