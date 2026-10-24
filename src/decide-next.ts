import { getNextTransitions, transition, type AnyMachineSnapshot } from "xstate";
import {
  createDecisionRequest,
  resolveDecision,
  type AgentDecisionExecutor,
  type AgentDecisionOption,
  type AgentDecisionRequest,
  type DecisionAttempt,
} from "./decision.js";
import { canonicalEventJson } from "./event-log.js";
import {
  getAcceptedEvents,
  getHumanEventTypes,
  isEventPattern,
  type EventFromSnapshot,
} from "./events.js";
import { isRecord } from "./internal/is-record.js";
import type { ChosenEvent, StandardSchemaV1 } from "./types.js";

/** Options for {@link decideNext}. */
export interface DecideNextOptions<TSnapshot extends AnyMachineSnapshot = AnyMachineSnapshot> {
  /** The decide executor that asks a model to pick one option. */
  decide: AgentDecisionExecutor;
  /** Model ref, passed through to the executor. */
  model: string;
  /** Event types the model may choose: exact types or wildcards (`'desk.*'`, `'*'`). */
  allowedEvents: string | readonly string[];
  /**
   * Concrete payloads per event type, without `type`. One option per payload.
   * A candidate type with no key is offered bare, as `{ type }`; an empty list
   * offers nothing for it. To withhold a type, give it `[]`:
   * `(s) => ({ "desk.refund": [{ amount: s.context.requested }], "desk.close": [] })`.
   */
  payloads?: (snapshot: TSnapshot) => Partial<Record<string, Record<string, unknown>[]>>;
  system?: string;
  prompt?: string;
  /** Semantic request name, for traces and scripted executors. Default `'decideNext'`. */
  name?: string;
  /**
   * Describe what each option changes: the state value and the changed
   * top-level context keys, computed with xstate's pure `transition()`.
   * An array limits which context keys are reported (a state value change is
   * always reported). Each reported value is cut to 120 characters.
   */
  lookahead?: boolean | readonly string[];
  /** Retries after a failed choice. Default `2`. */
  maxRetries?: number;
  signal?: AbortSignal;
}

/** Result of {@link decideNext}. */
export interface DecideNextResult<TEvent = ChosenEvent> {
  /** The chosen event, or `null` when the snapshot accepts none of the options. */
  event: TEvent | null;
  /** Failed attempts before the choice landed. */
  attempts: DecisionAttempt[];
  /** The request built for the executor, with the offered `options` and the same `withheld`. */
  request: AgentDecisionRequest;
  /**
   * The candidates the snapshot rejected: every `allowedEvents` type × payload,
   * built the same way as the offered options, where `snapshot.can(event)` was
   * false or the state handles the type through a transition tagged
   * `meta: { actor: "human" }`. Never offered to the model. Filled when
   * nothing is offered too.
   */
  withheld: ChosenEvent[];
}

/**
 * Asks a model to choose the next event for ANY XState snapshot, including a
 * machine built with plain `createMachine`/`setup` that knows nothing about AI.
 * The candidates are the `allowedEvents` an active state handles, one option per
 * payload, kept only where `snapshot.can(event)` is true and no transition
 * tagged `meta: { actor: "human" }` handles the type; the rest come back as
 * `withheld`. Each option is
 * described from the transition's `description`, else the event schema's,
 * plus (with `lookahead`) what it changes. The chosen event must equal one
 * offered option; anything else is retried.
 *
 * It never sends. The host sends the event, re-checking `can` first, because
 * the actor may have moved while the model was thinking. With no options it
 * returns `{ event: null }` without calling the executor. Exhausting retries
 * throws `AgentDecisionExhaustedError`.
 *
 * @example
 * ```ts no-check
 * let busy = false;
 * actor.subscribe(async (snapshot) => {
 *   if (busy || !snapshot.matches('reviewing')) return;
 *   busy = true;
 *   try {
 *     const { event } = await decideNext(snapshot, {
 *       decide,
 *       model: 'quick',
 *       allowedEvents: 'desk.*',
 *       payloads: (s) => ({ 'desk.refund': [{ amount: s.context.requested }] }),
 *       lookahead: true,
 *     });
 *     if (event && actor.getSnapshot().can(event)) actor.send(event);
 *   } finally {
 *     busy = false;
 *   }
 * });
 * ```
 */
export async function decideNext<TSnapshot extends AnyMachineSnapshot>(
  snapshot: TSnapshot,
  options: DecideNextOptions<TSnapshot>,
): Promise<DecideNextResult<EventFromSnapshot<TSnapshot>>> {
  const patterns =
    typeof options.allowedEvents === "string" ? [options.allowedEvents] : options.allowedEvents;
  const schemas = snapshot.machine.schemas?.events as Record<string, StandardSchemaV1> | undefined;
  const candidates = getAcceptedEvents(snapshot, { events: schemas, eventTypes: patterns }).filter(
    (event) => !isEventPattern(event.type),
  );
  const humanEventTypes = getHumanEventTypes(snapshot);
  const events = candidates.filter((event) => !humanEventTypes.has(event.type));
  const payloads = options.payloads?.(snapshot) ?? {};

  const accepted: ChosenEvent[] = [];
  const withheld: ChosenEvent[] = [];
  for (const { type } of candidates) {
    for (const payload of payloads[type] ?? [{}]) {
      const event = { ...payload, type };
      (!humanEventTypes.has(type) && safeCan(snapshot, event) ? accepted : withheld).push(event);
    }
  }

  const offered: AgentDecisionOption[] = accepted.map((event) => ({
    event,
    description: describeOption(snapshot, event, schemas?.[event.type], options.lookahead),
  }));

  const request = createDecisionRequest({
    name: options.name ?? "decideNext",
    model: options.model,
    system: options.system,
    prompt: options.prompt,
    input: { value: snapshot.value, context: snapshot.context },
    events,
    options: offered,
    withheld,
  });

  if (offered.length === 0) {
    return { event: null, attempts: [], request, withheld };
  }

  let attempts: DecisionAttempt[] = [];
  const event = await resolveDecision(
    request,
    {
      decide: (attemptRequest, info) => {
        attempts = attemptRequest.attempts;
        return options.decide(attemptRequest, info);
      },
    },
    {
      maxRetries: options.maxRetries,
      signal: options.signal,
      canTake: (chosen) => safeCan(snapshot, chosen),
    },
  );
  return { event: event as EventFromSnapshot<TSnapshot>, attempts, request, withheld };
}

function safeCan(snapshot: AnyMachineSnapshot, event: ChosenEvent): boolean {
  try {
    return snapshot.can(event);
  } catch {
    return false;
  }
}

// `what (field: value; …). Then: state: "a" → "b"; key: 1 → 2`
function describeOption(
  snapshot: AnyMachineSnapshot,
  event: ChosenEvent,
  schema: StandardSchemaV1 | undefined,
  lookahead: boolean | readonly string[] | undefined,
): string {
  const what =
    getNextTransitions(snapshot).find(
      (candidate) => candidate.eventType === event.type && candidate.description,
    )?.description ??
    schemaDescription(schema) ??
    event.type;
  const fields = Object.entries(event)
    .filter(([key]) => key !== "type")
    .map(([key, value]) => `${key}: ${short(value)}`);
  const base = fields.length ? `${what} (${fields.join("; ")})` : what;
  const effect = lookahead
    ? describeEffect(snapshot, event, lookahead === true ? undefined : lookahead)
    : undefined;
  return effect ? `${base}. Then: ${effect}` : base;
}

function schemaDescription(schema: StandardSchemaV1 | undefined): string | undefined {
  if (!schema) return undefined;
  const direct = (schema as { description?: unknown }).description;
  if (typeof direct === "string") return direct;
  try {
    const json = (
      schema["~standard"] as {
        jsonSchema?: { input?: (options: { target: string }) => unknown };
      }
    ).jsonSchema?.input?.({ target: "draft-2020-12" });
    return isRecord(json) && typeof json.description === "string" ? json.description : undefined;
  } catch {
    return undefined;
  }
}

function describeEffect(
  snapshot: AnyMachineSnapshot,
  event: ChosenEvent,
  keys: readonly string[] | undefined,
): string | undefined {
  const maxLength = 120;
  let next: AnyMachineSnapshot;
  try {
    [next] = transition(snapshot.machine, snapshot, event as never);
  } catch {
    return undefined;
  }
  const changes: string[] = [];
  if (canonicalEventJson(snapshot.value) !== canonicalEventJson(next.value)) {
    changes.push(`state: ${short(snapshot.value, maxLength)} → ${short(next.value, maxLength)}`);
  }
  const before = isRecord(snapshot.context) ? snapshot.context : {};
  const after = isRecord(next.context) ? next.context : {};
  for (const key of keys ?? new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (canonicalEventJson(before[key]) !== canonicalEventJson(after[key])) {
      changes.push(`${key}: ${short(before[key], maxLength)} → ${short(after[key], maxLength)}`);
    }
  }
  return changes.length ? changes.join("; ") : "nothing changes";
}

function short(value: unknown, max = 60): string {
  let text: string;
  try {
    text = value === undefined ? "(none)" : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
