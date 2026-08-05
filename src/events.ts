import {
  getNextTransitions,
  type AnyMachineSnapshot,
  type EventObject,
  type MachineSnapshot,
} from "xstate";
import type { StandardSchemaV1 } from "./types.js";
import { validateSchemaSync } from "./utils.js";

/** The invoke `src` of an {@link AgentRequest}/{@link AgentDecisionRequest} — a plain string, widened so literal `src` values still narrow in editor hints. */
// `& {}` keeps literal-union autocomplete alive while still allowing any string — a bare `string` in a union would swallow the literals.
export type AgentRequestSource = string & {};

/** Default prefix for the synthetic tool name generated per candidate event (e.g. `send_event_ASK`). Override per-request with {@link AgentEventToolNameResolver}. @internal */
const EVENT_TOOL_PREFIX = "send_event_" as const;

/** Customizes the tool name generated for a candidate event; see {@link AgentRequestOptions.eventToolName}. */
export type AgentEventToolNameResolver = (args: {
  eventType: string;
  defaultToolName: string;
}) => string;

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
 */
function matchesEventPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return eventType.startsWith(`${pattern.slice(0, -1)}`);
  }
  return eventType === pattern;
}

/**
 * The namespace reserved for events the library itself delivers to a machine
 * (`@agent.init`, `@agent.usage`). A machine may declare transitions on them,
 * but they are never model-facing: {@link getAcceptedEvents} drops them before
 * any `allowedEvents` matching, so they cannot be offered as a decision
 * candidate (not even under a `'*'` wildcard) and {@link parseAgentEvent}
 * rejects them — a model or a wire message must not be able to forge one.
 * Matched as a prefix rather than a list so this module stays free of an import
 * cycle back to `effects.ts`, where the constants live.
 * @internal
 */
const RESERVED_AGENT_EVENT_PREFIX = "@agent.";

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
  /** Machine input schema; `runAgent` validates `options.input` against it. */
  input?: StandardSchemaV1;
}

/** Shared options threaded through step discovery ({@link getAgentRequests}/{@link getAcceptedEvents}) — snapshot for event legality, event schemas for payload validation/tool schemas, and registered actor source logics. */
export interface AgentRequestOptions {
  snapshot?: AnyMachineSnapshot;
  events?: Record<string, StandardSchemaV1>;
  schemas?: AgentSchemas;
  actors?: Record<string, unknown>;
  /** Customize machine-event tool names. Defaults to send_event_<TYPE>. */
  eventToolName?: AgentEventToolNameResolver;
}

/** Recovers a machine's event union from its snapshot type, so {@link parseAgentEvent} returns the machine-typed event without a downstream cast. @internal */
export type EventFromSnapshot<TSnapshot> =
  TSnapshot extends MachineSnapshot<any, infer TEvent, any, any, any, any, any, any>
    ? TEvent
    : EventObject;

/**
 * Runtime-validates a dynamically-built `{ type, ...payload }` event against a
 * snapshot's currently-accepted events (via {@link getAcceptedEvents}) and,
 * when one is registered, the event type's payload schema — returning the
 * event typed as the machine's event union (recovered from the snapshot type)
 * so it can be sent to `runAgent({ event })` / `actor.send(...)` without an
 * `as never` cast. For generic, meta-driven hosts that assemble events from
 * user input or a wire message.
 *
 * Throws a descriptive error when `event.type` is not currently accepted
 * (listing the accepted types) or when its payload fails the registered schema.
 * Pass event payload schemas via `options.events`/`options.schemas` (the same
 * shape {@link getAcceptedEvents} takes) — the accepted TYPES always come from
 * the live snapshot; the schemas only add payload validation.
 *
 * @example
 * ```ts
 * const event = parseAgentEvent(result.snapshot, rawEvent, { events: schemas.events });
 * result = await runAgent(machine, { snapshot: result.snapshot, event, executors });
 * ```
 */
export function parseAgentEvent<TSnapshot extends AnyMachineSnapshot>(
  snapshot: TSnapshot,
  event: { type: string } & Record<string, unknown>,
  options: Pick<AgentRequestOptions, "events" | "schemas" | "eventToolName"> = {},
): EventFromSnapshot<TSnapshot> {
  const accepted = getAcceptedEvents(snapshot, options);
  const descriptor = accepted.find((candidate) => candidate.type === event.type);
  if (!descriptor) {
    throw new Error(
      `parseAgentEvent: '${event.type}' is not an accepted event in the current state. ` +
        `Accepted: ${accepted.map((candidate) => candidate.type).join(", ") || "(none)"}.`,
    );
  }

  if (descriptor.inputSchema) {
    const { type, ...payload } = event;
    try {
      const validatedPayload = validateSchemaSync(descriptor.inputSchema, payload);
      return {
        ...(validatedPayload as Record<string, unknown>),
        type,
      } as EventFromSnapshot<TSnapshot>;
    } catch (error) {
      throw new Error(
        `parseAgentEvent: '${event.type}' payload failed validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return event as EventFromSnapshot<TSnapshot>;
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
 */
export function getAcceptedEvents(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, "events" | "schemas" | "eventToolName"> & {
    eventTypes?: readonly string[];
  } = {},
): AgentEventDescriptor[] {
  const eventTypes = options.eventTypes;
  const seen = new Set<string>();
  const usedToolNames = new Set<string>();

  return getNextTransitions(snapshot).flatMap((transitionDefinition) => {
    const eventType = transitionDefinition.eventType;

    if (
      !eventType ||
      eventType === "*" ||
      eventType.startsWith("xstate.") ||
      eventType.startsWith(RESERVED_AGENT_EVENT_PREFIX) ||
      (eventTypes && !eventTypes.some((pattern) => matchesEventPattern(eventType, pattern))) ||
      seen.has(eventType)
    ) {
      return [];
    }

    seen.add(eventType);
    const defaultToolName = sanitizeEventToolName(eventType);
    const toolName = options.eventToolName
      ? options.eventToolName({ eventType, defaultToolName })
      : disambiguateEventToolName(defaultToolName, eventType, usedToolNames);

    const inputSchema = (options.events ?? options.schemas?.events)?.[eventType];

    return [
      {
        type: eventType,
        toolName,
        ...(inputSchema ? { inputSchema } : {}),
      },
    ];
  });
}
