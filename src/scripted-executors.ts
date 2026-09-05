/**
 * Scripted executors — a keyless, deterministic stand-in for a model host.
 *
 * `createScriptedExecutors` builds a full `{ generateText, streamText, decide }`
 * set (plus a `userInput` handler) that plays back canned answers from FIFO
 * queues, so `runAgent` (or
 * `provideExecutors`, or a bare `TextLogic.execute`) runs with no API key and no
 * network. It is the fastest way to see a machine run, and the least ceremonial
 * way to test one: same machine, same executor contract, scripted answers.
 *
 * @module
 */
import { AgentError } from "./errors.js";
import { isRecord } from "./internal/is-record.js";
import type { AgentDecisionRequest } from "./decision.js";
import type {
  AgentCallUsage,
  AgentRequestExecutorInfo,
  AgentRequestExecutors,
  AgentTextRequest,
  AgentUserInput,
} from "./text-logic.js";
import type { ChosenEvent } from "./types.js";

/**
 * A scripted `decide` answer: either the {@link ChosenEvent} itself (an object
 * with a string `type`), or the executor envelope `{ event, reason?, usage? }`
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
 * One entry in the `decisions` queue: a scripted answer, or a function of the
 * {@link AgentDecisionRequest} returning one (for choices that depend on the
 * prompt, the candidate `events`, or the prior failed `attempts`).
 */
export type ScriptedDecisionEntry =
  | ScriptedDecisionValue
  | ((request: AgentDecisionRequest) => ScriptedDecisionValue | PromiseLike<ScriptedDecisionValue>);

/**
 * One entry in the `text` queue: the request's output value (a string, or the
 * object a structured request declares), or a function of the
 * {@link AgentTextRequest} returning one.
 *
 * An entry is taken as the raw executor envelope (instead of the value itself)
 * only when its OWN keys are an `output` plus, optionally, `usage`/`raw` —
 * that is how an entry reports token `usage`. Anything else, including an
 * object that merely happens to have an `output` key alongside its own data
 * (`{ output: 'draft', confidence: 0.9 }`), is the output value. For a
 * structured request whose declared output is exactly `{ output }` (or
 * `{ output, usage }`), wrap it once more: `{ output: { output: '…' } }`.
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

/** A request-name keyed script. `"*"` is the fallback route. */
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
  kind: "generateText" | "streamText" | "decide" | "userInput";
  name: string;
  input: unknown;
  request: AgentTextRequest | AgentDecisionRequest | AgentUserInput;
}

/**
 * One entry in the `userInput` queue: the string the simulated human typed, or
 * a function of the {@link AgentUserInput} request (its `prompt`/`metadata`)
 * returning one.
 */
export type ScriptedUserInputEntry =
  | string
  | ((input: AgentUserInput) => string | PromiseLike<string>);

/**
 * The script {@link createScriptedExecutors} plays back.
 *
 * The key names match `simulateAgent`'s script (`decisions`, `text`,
 * `invokes`, `userInput`), but the shapes differ by design: `simulateAgent`
 * drives the pure step path and keys each channel BY SRC
 * (`text: { summarize: [...] }`), while these executors sit behind the real
 * executor contract, where one flat FIFO queue per channel is the ergonomic
 * form — route per request inside a function entry (`request.name`) when one
 * script must serve several requests. There is no `invokes` queue here:
 * non-`userInput` invokes are plain actors, supplied via `actors`.
 */
export interface ScriptedExecutorsScript {
  /** Answers for `decide` requests, keyed by semantic request name. A flat array is the legacy FIFO fallback. */
  decisions?: ScriptedDecisionEntry[] | ScriptedByName<ScriptedDecisionEntry>;
  /** Answers for generate requests, keyed by semantic request name. A flat array is the legacy FIFO fallback. */
  text?: ScriptedTextEntry[] | ScriptedByName<ScriptedTextEntry>;
  /** Stream chunks keyed by semantic request name. */
  stream?: Record<string, ScriptedStreamEntry>;
  /** Answers for `agent.userInput` requests, consumed in order. */
  userInput?: ScriptedUserInputEntry[];
  /** Reuse the last routed entry after its queue is exhausted. */
  repeat?: boolean;
  /** Default usage attached when an entry does not provide its own. */
  usage?: AgentCallUsage;
}

/**
 * What {@link createScriptedExecutors} returns: the full executor set, plus a
 * `userInput` handler for `runAgent`'s own `userInput` option (the builtin
 * `agent.userInput` actor is not an executor slot).
 */
export type ScriptedExecutors = Required<AgentRequestExecutors> & {
  userInput: (input: AgentUserInput) => Promise<string>;
  calls: ScriptedExecutorCall[];
};

interface ScriptQueue<T> {
  entries: T[];
  index: number;
}

function asQueue<T>(value: T | T[]): ScriptQueue<T> {
  return { entries: Array.isArray(value) ? [...value] : [value], index: 0 };
}

function namedQueues<T>(value: T[] | ScriptedByName<T> | undefined): {
  fifo: ScriptQueue<T>;
  byName: Map<string, ScriptQueue<T>>;
} {
  if (!value || Array.isArray(value)) {
    return { fifo: asQueue(value ?? []), byName: new Map() };
  }
  return {
    fifo: asQueue<T>([]),
    byName: new Map(Object.entries(value).map(([name, entries]) => [name, asQueue(entries)])),
  };
}

function takeEntry<T>(
  channel: { fifo: ScriptQueue<T>; byName: Map<string, ScriptQueue<T>> },
  name: string,
  repeat: boolean,
): T | undefined {
  const queue = channel.byName.get(name) ?? channel.byName.get("*") ?? channel.fifo;
  if (queue.index < queue.entries.length) {
    return queue.entries[queue.index++];
  }
  return repeat && queue.entries.length > 0 ? queue.entries.at(-1) : undefined;
}

/** The only own keys an executor-result envelope carries. @internal */
const TEXT_ENVELOPE_KEYS = new Set(["output", "usage", "raw"]);

/**
 * True when a scripted entry is the executor envelope rather than the output
 * value: it owns an `output` key and owns NOTHING outside the envelope's own
 * vocabulary. Bare `'output' in value` would swallow an output object's
 * siblings (`{ output: 'draft', confidence: 0.9 }` would lose `confidence`)
 * and would also match an inherited `output`. @internal
 */
function isTextEnvelope(value: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(value, "output") && Object.keys(value).every((key) => TEXT_ENVELOPE_KEYS.has(key))
  );
}

/**
 * Resolves ONE scripted text entry to an executor result: a function entry is
 * called with the request, and the value is taken as the raw envelope only when
 * it is one (see {@link isTextEnvelope}). Shared with `runSeam`, whose routed
 * queues follow the same entry conventions. @internal
 */
export async function resolveScriptedTextEntry(
  entry: ScriptedTextEntry,
  request: AgentTextRequest,
  info?: AgentRequestExecutorInfo,
): Promise<{ output: unknown; usage?: AgentCallUsage }> {
  const value = typeof entry === "function" ? await entry(request, info) : entry;
  return isRecord(value) && isTextEnvelope(value)
    ? (value as { output: unknown; usage?: AgentCallUsage })
    : { output: value };
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
  const output = isRecord(result) ? result["output"] : undefined;
  if (typeof output === "string") {
    info?.onChunk?.(output);
  }
}

/**
 * Keyless executors that replay a script instead of calling a model. Every
 * slot is provided, so any machine binds; a request with no entry left throws a
 * descriptive error naming what was pending.
 *
 * Queues are consumed FIFO and are copied on creation, so the caller's arrays
 * are never mutated and each call builds a fresh, independent playthrough.
 * Entries may be plain values or functions of the request, which is how one
 * script serves a machine that loops or branches: route on `request.name` (the
 * `setupAgent({ requests })` key) or on the decision's candidate `events`.
 *
 * @example
 * ```ts
 * const result = await runAgent(moderationMachine, {
 *   input: { comment: 'honestly this update is terrible', trust: 20 },
 *   executors: createScriptedExecutors({
 *     decisions: [{ type: 'FLAG', reason: 'Borderline tone.' }],
 *   }),
 * });
 * ```
 *
 * @example Dynamic entries
 * ```ts
 * createScriptedExecutors({
 *   text: [(request) => `Draft about ${request.prompt}`],
 *   decisions: [(request) => ({ type: request.events[0]!.type })],
 * });
 * ```
 *
 * @example Scripted human input
 * ```ts
 * const scripted = createScriptedExecutors({ userInput: ['ship it'] });
 * await runAgent(machine, { executors: scripted, userInput: scripted.userInput });
 * ```
 */
export function createScriptedExecutors(script: ScriptedExecutorsScript = {}): ScriptedExecutors {
  const decisions = namedQueues(script.decisions);
  const text = namedQueues(script.text);
  const userInput = [...(script.userInput ?? [])];
  const calls: ScriptedExecutorCall[] = [];
  const repeat = script.repeat ?? false;

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
    const entry = takeEntry(text, name, repeat);
    if (entry === undefined) {
      throw new AgentError(
        "scripted-executors-exhausted",
        `createScriptedExecutors: script ran dry on a pending text request ${describeText(request)}. ` +
          "Add another entry to the script's `text` queue.",
      );
    }
    return withDefaultUsage(await resolveScriptedTextEntry(entry, request, info));
  };

  return {
    calls,
    userInput: async (input) => {
      calls.push({ kind: "userInput", name: "agent.userInput", input, request: input });
      if (userInput.length === 0) {
        throw new AgentError(
          "scripted-executors-exhausted",
          "createScriptedExecutors: script ran dry on a pending userInput request " +
            `(prompt: ${input.prompt ? `'${input.prompt}'` : "(none)"}). ` +
            "Add another entry to the script's `userInput` queue.",
        );
      }
      const entry = userInput.shift()!;
      return typeof entry === "function" ? await entry(input) : entry;
    },
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
        return withDefaultUsage({ output: chunks.join("") });
      }
      const result = await nextText("streamText", request, info);
      emitScriptedChunk(result, info);
      return result;
    },
    decide: async (request) => {
      const name = request.name ?? request.id;
      calls.push({ kind: "decide", name, input: request.input, request });
      const entry = takeEntry(decisions, name, repeat);
      if (entry === undefined) {
        throw new AgentError(
          "scripted-executors-exhausted",
          `createScriptedExecutors: script ran dry on a pending decision request (id '${request.id}'). ` +
            "Add another entry to the script's `decisions` queue. " +
            `Candidate events: ${request.events.map((event) => event.type).join(", ") || "(none)"}.`,
        );
      }
      const value = typeof entry === "function" ? await entry(request) : entry;
      // A string `type` wins: chosen events may legitimately carry an `event`
      // payload field. Only an untyped object owning `event` is the envelope.
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
