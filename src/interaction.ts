import type { AnyMachineSnapshot, EventObject } from "xstate";
import { AgentIllegalResumeEventError } from "./run-agent.js";
import { getAcceptedEvents, parseAgentEvent } from "./events.js";
import { getStateMeta } from "./utils.js";

export interface AgentInteractionEvent {
  type: string;
  label: string;
  style?: string;
  /** Optional fixed fields merged into the event when this choice is selected. */
  event?: Record<string, unknown>;
}

export interface AgentInteraction {
  label: string;
  events: AgentInteractionEvent[];
  /** Event type used for a free-text response. */
  textEvent?: string;
}

interface InteractionMeta {
  label?: string | ((args: { context: unknown }) => string);
  events?: Record<
    string,
    | string
    | {
        label?: string;
        style?: string;
        event?: Record<string, unknown>;
      }
  >;
  textEvent?: string;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function interpolate(label: string, context: unknown): string {
  return label
    .replace(/\{([^{}]+)\}/g, (_, path: string) => {
      const value = readPath(context, path.trim());
      return value === undefined || value === null ? "" : String(value);
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads the active state's interaction metadata and filters it through the
 * events XState currently accepts. Returns `undefined` when none is declared. */
export function getInteraction(snapshot: AnyMachineSnapshot): AgentInteraction | undefined {
  const interaction = (getStateMeta(snapshot) as { interaction?: InteractionMeta }).interaction;
  if (!interaction) return undefined;

  const accepted = new Set(getAcceptedEvents(snapshot).map((event) => event.type));
  const label =
    typeof interaction.label === "function"
      ? interaction.label({ context: snapshot.context })
      : (interaction.label ?? "");
  const events = Object.entries(interaction.events ?? {})
    .filter(([type]) => accepted.has(type))
    .map(([type, config]) => {
      const descriptor = typeof config === "string" ? { label: config } : config;
      return {
        type,
        label: interpolate(descriptor.label ?? type, snapshot.context),
        ...(descriptor.style ? { style: descriptor.style } : {}),
        ...(descriptor.event ? { event: descriptor.event } : {}),
      };
    });

  return {
    label: interpolate(label, snapshot.context),
    events,
    ...(interaction.textEvent ? { textEvent: interaction.textEvent } : {}),
  };
}

/** Converts a rendered interaction choice back into a schema-validated machine
 * event. Fixed fields declared in metadata are merged before user fields. */
export function eventFromInteraction(
  snapshot: AnyMachineSnapshot,
  choice: ({ type: string } & Record<string, unknown>) | { text: string },
): EventObject {
  const interaction = getInteraction(snapshot);
  if (!interaction) {
    throw new AgentIllegalResumeEventError("(interaction)", []);
  }

  let event: { type: string } & Record<string, unknown>;
  if ("text" in choice) {
    if (!interaction.textEvent) {
      throw new AgentIllegalResumeEventError(
        "(text)",
        interaction.events.map(({ type }) => type),
      );
    }
    event = { type: interaction.textEvent, text: choice.text };
  } else {
    const descriptor = interaction.events.find(({ type }) => type === choice.type);
    if (!descriptor) {
      throw new AgentIllegalResumeEventError(
        choice.type,
        interaction.events.map(({ type }) => type),
      );
    }
    event = { ...descriptor.event, ...choice, type: choice.type };
  }

  return parseAgentEvent(snapshot, event);
}
