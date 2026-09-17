/**
 * Scripted executors — a deterministic stand-in for a model host.
 *
 * `createScriptedExecutors` builds a full `{ generateText, streamText, decide }`
 * set that plays back canned answers keyed by
 * request name, so `runAgent` (or `provideExecutors`, or a bare
 * `TextLogic.execute`) runs with no API key and no network.
 *
 * One rule: entries for a name are consumed in order, and the last entry
 * repeats forever.
 *
 * @module
 */
import { isRecord } from "./internal/is-record.js";
import type { AgentDecisionRequest } from "./decision.js";
import type {
  AgentCallUsage,
  AgentRequestExecutorInfo,
  AgentRequestExecutors,
  AgentTextRequest,
} from "./text-logic.js";
import type { ChosenEvent } from "./types.js";

/**
 * A scripted `decide` answer: either the {@link ChosenEvent} itself (an object
 * with a string `type`), or the executor result `{ event, reason?, usage? }`
 * when the entry also reports a `reason` or token `usage`.
 */
export type ScriptedDecisionValue =
  | ChosenEvent
  | {
      event: ChosenEvent;
      reason?: string;
      usage?: AgentCallUsage;
    };

/**
 * One scripted `decide` answer, or a function of the
 * {@link AgentDecisionRequest} returning one (for choices that depend on the
 * prompt, the candidate `events`, or the prior failed `attempts`).
 */
export type ScriptedDecisionEntry =
  | ScriptedDecisionValue
  | ((request: AgentDecisionRequest) => ScriptedDecisionValue | PromiseLike<ScriptedDecisionValue>);

/**
 * One scripted text answer: the request's output value (a string, or the
 * object a structured request declares), or a function of the
 * {@link AgentTextRequest} returning one.
 *
 * An entry is taken as the executor result (instead of the value itself)
 * only when its OWN keys are a `result` plus, optionally, `messages`/`usage`/
 * `raw` — that is how an entry reports token `usage`. Anything else, including
 * an object that merely happens to have a `result` key alongside its own data
 * (`{ result: 'draft', confidence: 0.9 }`), is the output value. For a
 * structured request whose declared output is exactly `{ result }` (or
 * `{ result, usage }`), wrap it once more: `{ result: { result: '…' } }`.
 */
export type ScriptedTextEntry =
  | ((request: AgentTextRequest, info?: AgentRequestExecutorInfo) => unknown)
  // The output value itself. Spelled out rather than `unknown` so a function
  // entry's `request` parameter is contextually typed.
  | string
  | number
  | boolean
  | null
  | object;

/**
 * A request-name keyed script. The key is the request's resolved `name` — the
 * authored name, else the invoke `id`. `"*"` is the fallback route.
 */
export type ScriptedByName<TEntry> = Record<string, TEntry | TEntry[]>;

/** One scripted stream call: chunks, or a function producing chunks. */
export type ScriptedStreamEntry =
  | string
  | readonly string[]
  | ((
      request: AgentTextRequest,
      info?: AgentRequestExecutorInfo,
    ) => string | readonly string[] | PromiseLike<string | readonly string[]>);

/** A call observed by {@link createScriptedExecutors}. */
export interface ScriptedExecutorCall {
  kind: "generateText" | "streamText" | "decide";
  name: string;
  input: unknown;
  request: AgentTextRequest | AgentDecisionRequest;
}

/**
 * The script {@link createScriptedExecutors} plays back. Every channel is
 * keyed by request name and consumed in order; the last entry for a name
 * repeats forever.
 */
export interface ScriptedExecutorsScript {
  /** Answers for `decide` requests, keyed by request name. */
  decisions?: ScriptedByName<ScriptedDecisionEntry>;
  /** Answers for generate requests, keyed by request name. */
  text?: ScriptedByName<ScriptedTextEntry>;
  /** Stream chunks keyed by request name. */
  stream?: Record<string, ScriptedStreamEntry>;
  /** Default usage attached when an entry does not provide its own. */
  usage?: AgentCallUsage;
}

/** What {@link createScriptedExecutors} returns: the full executor set plus the calls it observed. */
export type ScriptedExecutors = Required<AgentRequestExecutors> & {
  calls: ScriptedExecutorCall[];
};

interface ScriptQueue<T> {
  entries: T[];
  index: number;
}

function toQueues<T>(value: ScriptedByName<T> | undefined): Map<string, ScriptQueue<T>> {
  return new Map(
    Object.entries(value ?? {}).map(([name, entries]) => [
      name,
      { entries: Array.isArray(entries) ? [...entries] : [entries], index: 0 },
    ]),
  );
}

/**
 * Takes the next entry for `name`, holding on the last entry once the list is
 * spent. `undefined` means the script has no route for this name at all.
 * @internal
 */
function takeEntry<T>(queues: Map<string, ScriptQueue<T>>, name: string): T | undefined {
  const queue = queues.get(name) ?? queues.get("*");
  if (!queue || queue.entries.length === 0) {
    return undefined;
  }
  const entry = queue.entries[Math.min(queue.index, queue.entries.length - 1)];
  queue.index++;
  return entry;
}

/** @internal */
function noAnswer(name: string, queues: Map<string, unknown>): Error {
  const known = [...queues.keys()].join(", ") || "(none)";
  return new Error(`No scripted answer for request '${name}'. Known: ${known}`);
}

/** The only own keys an executor result carries. @internal */
const TEXT_RESULT_KEYS = new Set(["result", "messages", "usage", "raw"]);

/**
 * True when a scripted entry is the executor result rather than the output
 * value: it owns a `result` key and owns NOTHING outside the result's own
 * vocabulary. Bare `'result' in value` would swallow an output object's
 * siblings (`{ result: 'draft', confidence: 0.9 }` would lose `confidence`)
 * and would also match an inherited `result`. @internal
 */
function isTextResult(value: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(value, "result") && Object.keys(value).every((key) => TEXT_RESULT_KEYS.has(key))
  );
}

/**
 * Resolves ONE scripted text entry to an executor result: a function entry is
 * called with the request, and the value is taken as the executor result only
 * when it is one (see {@link isTextResult}). Shared with `runSeam`, whose routed
 * queues follow the same entry conventions. @internal
 */
export async function resolveScriptedTextEntry(
  entry: ScriptedTextEntry,
  request: AgentTextRequest,
  info?: AgentRequestExecutorInfo,
): Promise<{ result: unknown; usage?: AgentCallUsage }> {
  const value = typeof entry === "function" ? await entry(request, info) : entry;
  return isRecord(value) && isTextResult(value)
    ? (value as { result: unknown; usage?: AgentCallUsage })
    : { result: value };
}

/**
 * Names a pending text request in an error message. Shared with `runSeam`.
 * @internal
 */
export function describeText(request: AgentTextRequest): string {
  return request.name
    ? `'${request.name}' (model '${request.model}')`
    : `(model '${request.model}')`;
}

/**
 * Stream semantics with no model: the whole text lands as one chunk. Shared
 * with `runSeam`, whose scripted answers stream the same way. @internal
 */
export function emitScriptedChunk(result: unknown, info?: AgentRequestExecutorInfo): void {
  const text = isRecord(result) ? result["result"] : undefined;
  if (typeof text === "string") {
    info?.onChunk?.(text);
  }
}

/**
 * Executors that replay a script instead of calling a model. Every slot is
 * provided, so any machine binds.
 *
 * Answers are keyed by the request's resolved name — its authored `name`, else
 * the invoke `id` — and `"*"` serves anything unmatched.
 * Entries for a name are consumed in order and the last one repeats forever, so
 * a looping machine needs no extra option. A request the script has no route
 * for throws an ordinary `Error` from inside the executor, which reaches the
 * machine as an actor error.
 *
 * Queues are copied on creation, so the caller's arrays are never mutated and
 * each call builds a fresh, independent playthrough. Entries may be plain
 * values or functions of the request.
 *
 * @example
 * ```ts
 * const result = await runAgent(moderationMachine, {
 *   input: { comment: 'honestly this update is terrible', trust: 20 },
 *   executors: createScriptedExecutors({
 *     decisions: { moderate: [{ type: 'FLAG', reason: 'Borderline tone.' }] },
 *   }),
 * });
 * ```
 *
 * @example Dynamic entries
 * ```ts
 * createScriptedExecutors({
 *   text: { draft: (request) => `Draft about ${request.prompt}` },
 *   decisions: { route: (request) => ({ type: request.events[0]!.type }) },
 * });
 * ```
 */
export function createScriptedExecutors(script: ScriptedExecutorsScript = {}): ScriptedExecutors {
  const decisions = toQueues(script.decisions);
  const text = toQueues(script.text);
  const calls: ScriptedExecutorCall[] = [];

  const withDefaultUsage = <T extends object>(result: T): T & { usage?: AgentCallUsage } =>
    (result as { usage?: AgentCallUsage }).usage || !script.usage
      ? result
      : { ...result, usage: script.usage };

  const nextText = async (
    kind: "generateText" | "streamText",
    request: AgentTextRequest,
    info?: AgentRequestExecutorInfo,
  ) => {
    const name = request.name ?? "*";
    calls.push({ kind, name, input: request.input, request });
    const entry = takeEntry(text, name);
    if (entry === undefined) {
      throw noAnswer(name, text);
    }
    return withDefaultUsage(await resolveScriptedTextEntry(entry, request, info));
  };

  return {
    calls,
    generateText: (request, info) => nextText("generateText", request, info),
    streamText: async (request, info) => {
      const name = request.name ?? "*";
      const streamEntry = script.stream?.[name] ?? script.stream?.["*"];
      if (streamEntry !== undefined) {
        calls.push({ kind: "streamText", name, input: request.input, request });
        const resolved =
          typeof streamEntry === "function" ? await streamEntry(request, info) : streamEntry;
        const chunks = typeof resolved === "string" ? [resolved] : [...resolved];
        for (const chunk of chunks) info?.onChunk?.(chunk);
        return withDefaultUsage({ result: chunks.join("") });
      }
      const result = await nextText("streamText", request, info);
      emitScriptedChunk(result, info);
      return result;
    },
    decide: async (request) => {
      const name = request.name ?? request.id;
      calls.push({ kind: "decide", name, input: request.input, request });
      const entry = takeEntry(decisions, name);
      if (entry === undefined) {
        throw noAnswer(name, decisions);
      }
      const value = typeof entry === "function" ? await entry(request) : entry;
      // A string `type` wins: chosen events may legitimately carry an `event`
      // payload field. Only an untyped object owning `event` is the executor result.
      const result =
        isRecord(value) &&
        typeof (value as Record<string, unknown>)["type"] !== "string" &&
        "event" in value
          ? (value as { event: ChosenEvent })
          : { event: value as ChosenEvent };
      return withDefaultUsage(result);
    },
  };
}
