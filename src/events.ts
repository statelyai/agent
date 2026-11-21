import {
  getNextTransitions,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type AnyStateNode,
  type AnyTransitionDefinition,
  type EventFromLogic,
  type EventObject,
  type MachineSnapshot,
} from "xstate";
import { AgentError } from "./errors.js";
import { getAgentExecutionOptions } from "./internal/registry.js";
import type { StandardSchemaV1 } from "./types.js";
import { isRecord } from "./internal/is-record.js";
import { validateSchemaSync } from "./utils.js";

/**
 * Thrown by {@link parseAgentEvent} (and {@link eventFromInteraction}) when a
 * wire payload is not a usable event: it is not an object with a string
 * `type`, it names a reserved `@agent.*` type, or its fields fail the schema
 * the machine registered for that type. A host turns it into a 400.
 *
 * Not handling an event is NOT this error — a state machine ignores events it
 * has no transition for, so an event the current state does not handle parses
 * fine and settles the run with `result.ignored` set.
 */
export class AgentInvalidEventPayloadError extends AgentError {
  readonly eventType: string;
  constructor(eventType: string, detail: string) {
    super("invalid-event-payload", `Invalid event payload for '${eventType}': ${detail}`);
    this.name = "AgentInvalidEventPayloadError";
    this.eventType = eventType;
  }
}

/** The invoke `src` of an {@link AgentRequest}/{@link AgentDecisionRequest} — a plain string, widened so literal `src` values still narrow in editor hints. */
// `& {}` keeps literal-union autocomplete alive while still allowing any string — a bare `string` in a union would swallow the literals.
export type AgentRequestSource = string & {};

/** Prefix for the synthetic tool name generated per candidate event (e.g. `send_event_ASK`). @internal */
const EVENT_TOOL_PREFIX = "send_event_" as const;

// Short deterministic hash, used to keep generated tool names within length limits while staying unique.
function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

// Default `EVENT_TOOL_PREFIX`-based tool name for an event type, truncated+hashed if over 64 chars.
export function sanitizeEventToolName(eventType: string): `${typeof EVENT_TOOL_PREFIX}${string}` {
  const sanitizedType = eventType.replace(/[^a-zA-Z0-9_-]/g, "_") || "event";
  const base = `${EVENT_TOOL_PREFIX}${sanitizedType}`;

  if (base.length <= 64) {
    return base as `${typeof EVENT_TOOL_PREFIX}${string}`;
  }

  const hash = hashString(eventType);
  const prefixLength = 64 - hash.length - 1;
  return `${base.slice(0, prefixLength)}_${hash}` as `${typeof EVENT_TOOL_PREFIX}${string}`;
}

// Resolves a tool-name collision by appending a hash suffix, so two distinct event types never share a tool name.
function disambiguateEventToolName(
  toolName: string,
  eventType: string,
  usedToolNames: Set<string>,
): string {
  if (!usedToolNames.has(toolName)) {
    usedToolNames.add(toolName);
    return toolName;
  }

  const hash = hashString(eventType);
  const suffix = `_${hash}`;
  const uniqueToolName = `${toolName.slice(0, 64 - suffix.length)}${suffix}`;
  usedToolNames.add(uniqueToolName);
  return uniqueToolName;
}

/**
 * True when an event type matches an `allowedEvents` entry: an exact type,
 * `'*'` (every event), or a `'prefix.*'` wildcard matching any deeper
 * segment (`'todo.*'` matches `'todo.add'` and `'todo.list.clear'`, not
 * `'todo'` itself — mirroring xstate's partial wildcard events).
 * @internal
 */
export function matchesEventPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return eventType.startsWith(`${pattern.slice(0, -1)}`);
  }
  return eventType === pattern;
}

/**
 * True when xstate routes `eventType` to a transition keyed `descriptor`: the
 * same rule as xstate's own (unexported) `matchesEventDescriptor`. `'desk.*'`
 * matches `'desk'`, `'desk.refund'` and `'desk.case.close'`; `'*'` matches
 * every type.
 */
/** @internal */
export function matchesHandlerDescriptor(eventType: string, descriptor: string): boolean {
  if (descriptor === eventType || descriptor === "*") return true;
  if (!descriptor.endsWith(".*")) return false;
  const descriptorTokens = descriptor.split(".");
  const eventTokens = eventType.split(".");
  for (let index = 0; index < descriptorTokens.length; index++) {
    if (descriptorTokens[index] === "*") return index === descriptorTokens.length - 1;
    if (descriptorTokens[index] !== eventTokens[index]) return false;
  }
  return true;
}

/**
 * Event types reserved for delivery by the library (`@agent.*`). A machine
 * may declare transitions on them,
 * but they are never model-facing: {@link getAcceptedEvents} drops them before
 * any `allowedEvents` matching, so they cannot be offered as a decision
 * candidate (not even under a `'*'` wildcard) and {@link parseAgentEvent}
 * rejects them — a model or a wire message must not be able to forge one.
 * @internal
 */
const RESERVED_AGENT_EVENT_PREFIX = "@agent.";

function isReservedAgentEvent(eventType: string): boolean {
  return eventType.startsWith(RESERVED_AGENT_EVENT_PREFIX);
}

/** True when an `allowedEvents` entry is a wildcard pattern rather than a concrete event type. @internal */
export function isEventPattern(entry: string): boolean {
  return entry === "*" || entry.endsWith(".*");
}

/** One candidate event a decision (or {@link getAcceptedEvents} caller) may choose: its type, the synthetic tool name a model can call to pick it, and its payload schema if one is registered. */
export interface AgentEventDescriptor {
  type: string;
  toolName: string;
  inputSchema?: StandardSchemaV1;
}

/** Registered schemas, as attached to a machine by `setupAgent`/`createAgentSchemas`. */
export interface AgentSchemas {
  events?: Record<string, StandardSchemaV1>;
  /** Machine input schema; the runtime validates the run's `input` against it. */
  input?: StandardSchemaV1;
}

/** Shared options threaded through step discovery ({@link getAgentRequests}/{@link getAcceptedEvents}) — snapshot for event legality, event schemas for payload validation/tool schemas, and registered actor source logics. */
export interface AgentRequestOptions {
  snapshot?: AnyMachineSnapshot;
  events?: Record<string, StandardSchemaV1>;
  schemas?: AgentSchemas;
  actors?: Record<string, unknown>;
}

/** Recovers a machine's event union from its snapshot type, so {@link parseAgentEvent} returns the machine-typed event without a downstream cast. @internal */
export type EventFromSnapshot<TSnapshot> =
  TSnapshot extends MachineSnapshot<any, infer TEvent, any, any, any, any, any, any>
    ? TEvent
    : EventObject;

/** The machine event union {@link parseAgentEvent} returns, from a machine or from a snapshot of one. @internal */
export type ParsedAgentEvent<TSource> = TSource extends AnyStateMachine
  ? EventFromLogic<TSource>
  : EventFromSnapshot<TSource>;

/**
 * Parses a wire payload (a request body, a socket frame) into an
 * event typed as the machine's event union, so it can go straight to
 * `runToQuiescence(runtime, { event })` / `actor.send(...)` without a cast. Pass the machine
 * itself, or any snapshot of it.
 *
 * It checks exactly what a schema can check: the payload is an object with a
 * string `type`, that type is not one of the library-reserved `@agent.*` types,
 * and — when the machine registered a schema for it — the fields satisfy that
 * schema (defaults filled, transforms applied). Anything else throws
 * {@link AgentInvalidEventPayloadError}, which a host answers with a 400.
 *
 * It deliberately does NOT check whether the current state handles the event.
 * State machines ignore events they have no transition for; that is normal
 * behavior, not a validation failure. Send the parsed event and read
 * `result.ignored` if the host wants to tell the client nothing happened.
 *
 * @example
 * ```ts
 * const event = parseAgentEvent(machine, await request.json());
 * const runtime = createAgentRuntime(machine, { store, threadId, executors });
 * const result = await runToQuiescence(runtime, { event });
 * ```
 */
export function parseAgentEvent<TSource extends AnyStateMachine | AnyMachineSnapshot>(
  source: TSource,
  payload: unknown,
  options: Pick<AgentRequestOptions, "events" | "schemas"> = {},
): ParsedAgentEvent<TSource> {
  if (!isRecord(payload) || typeof (payload as { type?: unknown }).type !== "string") {
    throw new AgentInvalidEventPayloadError(
      "(unknown)",
      "expected an object with a string `type`.",
    );
  }
  const event = payload as { type: string } & Record<string, unknown>;
  if (isReservedAgentEvent(event.type)) {
    throw new AgentInvalidEventPayloadError(
      event.type,
      "this event type is reserved for the library and cannot be sent from outside.",
    );
  }

  const machine = (
    typeof (source as { provide?: unknown }).provide === "function"
      ? source
      : (source as AnyMachineSnapshot).machine
  ) as AnyStateMachine | undefined;
  const registered = getAgentExecutionOptions(machine)?.schemas;
  const eventSchemas = options.events ?? options.schemas?.events ?? registered?.events;
  const inputSchema = eventSchemas?.[event.type];
  if (!inputSchema) {
    return event as ParsedAgentEvent<TSource>;
  }

  const { type, ...fields } = event;
  try {
    const validated = validateSchemaSync(inputSchema, fields) as Record<string, unknown>;
    return { ...validated, type } as ParsedAgentEvent<TSource>;
  } catch (error) {
    throw new AgentInvalidEventPayloadError(
      event.type,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Lists the events a snapshot can currently accept, as {@link AgentEventDescriptor}s
 * a model can be offered (via `resolveDecision`/an adapter's tool-per-event
 * mapping). **Filters by event TYPE only** — it does not evaluate guards, so
 * a type-legal-but-guard-rejected event can still appear here. Guard
 * legality is checked separately, at decision-resolution time, via
 * `snapshot.can(event)` (the `canTake` option of {@link resolveDecision} /
 * {@link ResolveDecisionOptions}). Pass `eventTypes` to further narrow to a
 * declared `allowedEvents` set — entries may be exact types or wildcard
 * patterns (`'*'`, `'todo.*'`; see {@link matchesEventPattern}).
 *
 * XState-internal (`xstate.*`) and library-reserved
 * ({@link RESERVED_AGENT_EVENT_PREFIX}) event types are always excluded, before
 * any `allowedEvents` matching — a machine that handles `'@agent.usage'` still
 * never offers it to a model.
 *
 * A partial wildcard handler (`on: { 'desk.*': ... }`) lists the event types
 * registered in `events`/`schemas` (else the machine's own event schemas) that
 * it matches, by xstate's rule; with none registered, it lists the pattern
 * itself, which a model cannot choose.
 *
 * Pass `actor: "agent"` for the list a model may choose from: it also drops an
 * event the state handles through a transition tagged `meta: { actor: "human" }`.
 */
export function getAcceptedEvents(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, "events" | "schemas"> & {
    eventTypes?: readonly string[];
    actor?: "agent";
  } = {},
): AgentEventDescriptor[] {
  const humanEventTypes: ReadonlySet<string> =
    options.actor === "agent"
      ? getHumanEventTypes(snapshot, options.events ?? options.schemas?.events)
      : new Set();
  return describeEventTransitions(snapshot, getNextTransitions(snapshot), humanEventTypes, options);
}

/**
 * The events an `agent.act` invoke offers as tools: what the snapshot accepts
 * now, plus every event the invoking state node can accept while it stays
 * active (its own and its ancestors' handlers, and all of its descendants').
 * An event is left out when every one of those handlers is tagged
 * `meta: { actor: "human" }`. Filters, wildcard expansion and tool names match
 * {@link getAcceptedEvents}. @internal
 */
export function getActEvents(
  snapshot: AnyMachineSnapshot,
  invokeId: string,
  options: Pick<AgentRequestOptions, "events" | "schemas"> & {
    eventTypes?: readonly string[];
  } = {},
): AgentEventDescriptor[] {
  const transitions = [...getNextTransitions(snapshot)];
  const node = snapshot.nodes.find((stateNode) =>
    stateNode.invoke.some((invoke) => invoke.id === invokeId),
  );
  const collect = (stateNode: AnyStateNode, descend: boolean): void => {
    for (const list of stateNode.transitions.values()) transitions.push(...list);
    if (descend) for (const child of Object.values(stateNode.states)) collect(child, true);
  };
  if (node) {
    collect(node, true);
    for (let parent = node.parent; parent; parent = parent.parent) collect(parent, false);
  }
  const schemas = options.events ?? options.schemas?.events;
  const humanOnly = new Set<string>();
  const agentSendable = new Set<string>();
  for (const transition of transitions) {
    const human = (transition.meta as { actor?: unknown } | undefined)?.actor === "human";
    const into = human ? humanOnly : agentSendable;
    into.add(transition.eventType);
    for (const type of expandHandlerType(snapshot, transition.eventType, schemas)) into.add(type);
  }
  for (const eventType of agentSendable) humanOnly.delete(eventType);
  return describeEventTransitions(snapshot, transitions, humanOnly, options);
}

function describeEventTransitions(
  snapshot: AnyMachineSnapshot,
  transitions: readonly AnyTransitionDefinition[],
  excludedEventTypes: ReadonlySet<string>,
  options: Pick<AgentRequestOptions, "events" | "schemas"> & { eventTypes?: readonly string[] },
): AgentEventDescriptor[] {
  const eventTypes = options.eventTypes;
  const seen = new Set<string>();
  const usedToolNames = new Set<string>();
  const schemas = options.events ?? options.schemas?.events;

  return transitions.flatMap((transitionDefinition) => {
    const handlerType = transitionDefinition.eventType;
    if (!handlerType) return [];
    // A wildcard transition tagged `meta: { actor: "human" }` covers what it expands to.
    const humanHandler = excludedEventTypes.has(handlerType);
    return expandHandlerType(snapshot, handlerType, schemas).flatMap((eventType) =>
      describeAcceptedEvent(eventType, humanHandler, eventType !== handlerType),
    );
  });

  function describeAcceptedEvent(
    eventType: string,
    humanHandler: boolean,
    expanded: boolean,
  ): AgentEventDescriptor[] {
    if (
      eventType === "*" ||
      eventType.startsWith("xstate.") ||
      isReservedAgentEvent(eventType) ||
      humanHandler ||
      excludedEventTypes.has(eventType) ||
      (eventTypes && !eventTypes.some((pattern) => matchesEventPattern(eventType, pattern))) ||
      seen.has(eventType)
    ) {
      return [];
    }

    seen.add(eventType);
    const defaultToolName = sanitizeEventToolName(eventType);
    const toolName = disambiguateEventToolName(defaultToolName, eventType, usedToolNames);

    // A type a wildcard expanded to keeps the schema it was found in, which
    // may be the machine's own when no `schemas` option is passed.
    const inputSchema =
      schemas?.[eventType] ??
      (expanded
        ? (snapshot.machine.schemas?.events as Record<string, StandardSchemaV1> | undefined)?.[
            eventType
          ]
        : undefined);

    return [
      {
        type: eventType,
        toolName,
        ...(inputSchema ? { inputSchema } : {}),
      },
    ];
  }
}

/**
 * The event types a handler keyed `handlerType` accepts: a partial wildcard
 * (`'desk.*'`) stands for the registered event types it matches, read from
 * `schemas`, else the machine's own. With none registered, or for any other
 * handler, the key itself.
 */
function expandHandlerType(
  snapshot: AnyMachineSnapshot,
  handlerType: string,
  schemas?: Record<string, unknown>,
): string[] {
  if (handlerType === "*" || !handlerType.endsWith(".*")) return [handlerType];
  // A supplied registry (the root's, for an invoked child) and the machine's own.
  const registered = new Set([
    ...Object.keys(schemas ?? {}),
    ...Object.keys((snapshot.machine.schemas?.events as Record<string, unknown> | undefined) ?? {}),
  ]);
  const matched = [...registered].filter(
    (type) => !isEventPattern(type) && matchesHandlerDescriptor(type, handlerType),
  );
  return matched.length ? matched : [handlerType];
}

/**
 * The event types a snapshot handles through a transition tagged
 * `meta: { actor: "human" }`: a person sends them, so no model is offered them.
 * @internal
 */
export function getHumanEventTypes(
  snapshot: AnyMachineSnapshot,
  events?: Record<string, unknown>,
): ReadonlySet<string> {
  // Cached per snapshot only without a registry: a registry changes what a
  // wildcard expands to.
  let types = events ? undefined : humanEventTypesBySnapshot.get(snapshot);
  if (!types) {
    types = new Set();
    for (const transition of getNextTransitions(snapshot)) {
      if ((transition.meta as { actor?: unknown } | undefined)?.actor === "human") {
        types.add(transition.eventType);
        for (const type of expandHandlerType(snapshot, transition.eventType, events)) {
          types.add(type);
        }
      }
    }
    if (!events) humanEventTypesBySnapshot.set(snapshot, types);
  }
  return types;
}

// Snapshots are immutable, so each one's human event types are read once.
const humanEventTypesBySnapshot = new WeakMap<AnyMachineSnapshot, Set<string>>();
