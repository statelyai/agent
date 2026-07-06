import { getNextTransitions, type AnyMachineSnapshot } from "xstate";
import type { StandardSchemaV1 } from "./types.js";

/** The invoke `src` of an {@link AgentRequest}/{@link AgentDecisionRequest} — a plain string, widened so literal `src` values still narrow in editor hints. */
export type AgentRequestSource = string & {};

/** Default prefix for the synthetic tool name generated per candidate event (e.g. `send_event_ASK`). Override per-request with {@link AgentEventToolNameResolver}. */
export const EVENT_TOOL_PREFIX = "send_event_" as const;

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

/** One candidate event a decision (or {@link getAcceptedEvents} caller) may choose: its type, the synthetic tool name a model can call to pick it, and its payload schema if one is registered. */
export interface AgentEventDescriptor {
  type: string;
  toolName: string;
  inputSchema?: StandardSchemaV1;
}

/** Registered event payload schemas, as attached to a machine by `setupAgent`/`createAgentSchemas`. */
export interface AgentSchemas {
  events?: Record<string, StandardSchemaV1>;
}

/** Shared options threaded through step discovery ({@link getAgentRequests}/{@link getAcceptedEvents}) — snapshot for event legality, event schemas for payload validation/tool schemas, and registered actor source logics. */
export interface AgentRequestOptions {
  snapshot?: AnyMachineSnapshot;
  events?: Record<string, StandardSchemaV1>;
  schemas?: AgentSchemas;
  actorSources?: Record<string, unknown>;
  /** Customize machine-event tool names. Defaults to send_event_<TYPE>. */
  eventToolName?: AgentEventToolNameResolver;
}

/**
 * Lists the events a snapshot can currently accept, as {@link AgentEventDescriptor}s
 * a model can be offered (via `resolveDecision`/an adapter's tool-per-event
 * mapping). **Filters by event TYPE only** — it does not evaluate guards, so
 * a type-legal-but-guard-rejected event can still appear here. Guard
 * legality is checked separately, at decision-resolution time, via
 * `snapshot.can(event)` (the `canTake` option of {@link resolveDecision} /
 * {@link ResolveDecisionOptions}). Pass `eventTypes` to further narrow to a
 * declared `allowedEvents` set.
 */
export function getAcceptedEvents(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, "events" | "schemas" | "eventToolName"> & {
    eventTypes?: readonly string[];
  } = {},
): AgentEventDescriptor[] {
  const eventTypes = options.eventTypes === undefined ? undefined : new Set(options.eventTypes);
  const seen = new Set<string>();
  const usedToolNames = new Set<string>();

  return getNextTransitions(snapshot).flatMap((transitionDefinition) => {
    const eventType = transitionDefinition.eventType;

    if (
      !eventType ||
      eventType === "*" ||
      eventType.startsWith("xstate.") ||
      (eventTypes && !eventTypes.has(eventType)) ||
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
