import { getNextTransitions, type AnyMachineSnapshot } from 'xstate';
import type { StandardSchemaV1 } from './types.js';

export type AgentRequestSource = string & {};

export const EVENT_TOOL_PREFIX = 'send_event_' as const;

export type AgentEventToolNameResolver = (args: {
  eventType: string;
  defaultToolName: string;
}) => string;

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export function sanitizeEventToolName(eventType: string): `${typeof EVENT_TOOL_PREFIX}${string}` {
  const sanitizedType = eventType.replace(/[^a-zA-Z0-9_-]/g, '_') || 'event';
  const base = `${EVENT_TOOL_PREFIX}${sanitizedType}`;

  if (base.length <= 64) {
    return base as `${typeof EVENT_TOOL_PREFIX}${string}`;
  }

  const hash = hashString(eventType);
  const prefixLength = 64 - hash.length - 1;
  return `${base.slice(0, prefixLength)}_${hash}` as `${typeof EVENT_TOOL_PREFIX}${string}`;
}

export function disambiguateEventToolName(
  toolName: string,
  eventType: string,
  usedToolNames: Set<string>
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

export interface AgentEventDescriptor {
  type: string;
  toolName: string;
  inputSchema?: StandardSchemaV1;
}

export interface AgentSchemas {
  events?: Record<string, StandardSchemaV1>;
}

export interface AgentRequestOptions {
  snapshot?: AnyMachineSnapshot;
  events?: Record<string, StandardSchemaV1>;
  schemas?: AgentSchemas;
  actors?: Record<string, unknown>;
  /** Customize machine-event tool names. Defaults to send_event_<TYPE>. */
  eventToolName?: AgentEventToolNameResolver;
}

export function getAcceptedEvents(
  snapshot: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, 'events' | 'schemas' | 'eventToolName'> & {
    eventTypes?: readonly string[];
  } = {}
): AgentEventDescriptor[] {
  const eventTypes =
    options.eventTypes === undefined
      ? undefined
      : new Set(options.eventTypes);
  const seen = new Set<string>();
  const usedToolNames = new Set<string>();

  return getNextTransitions(snapshot).flatMap((transitionDefinition) => {
    const eventType = transitionDefinition.eventType;

    if (
      !eventType
      || eventType === '*'
      || eventType.startsWith('xstate.')
      || (eventTypes && !eventTypes.has(eventType))
      || seen.has(eventType)
    ) {
      return [];
    }

    seen.add(eventType);
    const defaultToolName = sanitizeEventToolName(eventType);
    const toolName = options.eventToolName
      ? options.eventToolName({ eventType, defaultToolName })
      : disambiguateEventToolName(defaultToolName, eventType, usedToolNames);

    return [{
      type: eventType,
      toolName,
      ...((options.events ?? options.schemas?.events)?.[eventType]
        ? { inputSchema: (options.events ?? options.schemas?.events)![eventType] }
        : {}),
    }];
  });
}
