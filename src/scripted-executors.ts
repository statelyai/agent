/**
 * Scripted executors — a keyless, deterministic stand-in for a model host.
 *
 * `createScriptedExecutors` builds a full `{ generateText, streamText, decide }`
 * set that plays back canned answers from FIFO queues, so `runAgent` (or
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

/** The script {@link createScriptedExecutors} plays back. */
export interface ScriptedExecutorsScript {
  /** Answers for `decide` requests, consumed in order. */
  decisions?: ScriptedDecisionEntry[];
  /** Answers for text requests, consumed in order. `generateText` and `streamText` share this one queue. */
  text?: ScriptedTextEntry[];
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
 */
export function createScriptedExecutors(
  script: ScriptedExecutorsScript = {},
): Required<AgentRequestExecutors> {
  const decisions = [...(script.decisions ?? [])];
  const text = [...(script.text ?? [])];

  const nextText = async (request: AgentTextRequest, info?: AgentRequestExecutorInfo) => {
    if (text.length === 0) {
      throw new AgentError(
        "scripted-executors-exhausted",
        `createScriptedExecutors: script ran dry on a pending text request ${describeText(request)}. ` +
          "Add another entry to the script's `text` queue.",
      );
    }
    return resolveScriptedTextEntry(text.shift()!, request, info);
  };

  return {
    generateText: nextText,
    streamText: async (request, info) => {
      const result = await nextText(request, info);
      emitScriptedChunk(result, info);
      return result;
    },
    decide: async (request) => {
      if (decisions.length === 0) {
        throw new AgentError(
          "scripted-executors-exhausted",
          `createScriptedExecutors: script ran dry on a pending decision request (id '${request.id}'). ` +
            "Add another entry to the script's `decisions` queue. " +
            `Candidate events: ${request.events.map((event) => event.type).join(", ") || "(none)"}.`,
        );
      }
      const entry = decisions.shift()!;
      const value = typeof entry === "function" ? await entry(request) : entry;
      // The envelope owns an `event`; anything else is the `ChosenEvent` itself.
      return isRecord(value) && "event" in value
        ? (value as { event: ChosenEvent })
        : { event: value as ChosenEvent };
    },
  };
}
