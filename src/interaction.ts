import type { AnyMachineSnapshot, EventObject } from "xstate";
import { AgentIllegalResumeEventError } from "./run-agent.js";
import { getAcceptedEvents, parseAgentEvent, type EventFromSnapshot } from "./events.js";
import { getStateMeta } from "./utils.js";
import type { StandardSchemaV1 } from "./types.js";

export interface AgentInteractionEvent<TType extends string = string> {
  type: TType;
  label: string;
  style?: string;
  /** Optional fixed fields merged into the event when this choice is selected. */
  event?: Record<string, unknown>;
}

export interface AgentInteraction<TEvent extends EventObject = EventObject> {
  label: string;
  events: AgentInteractionEvent<TEvent["type"]>[];
  /** Event type used for a free-text response. */
  textEvent?: TEvent["type"];
}

/**
 * One choice as authored in `meta.interaction.events`: a bare label, or a
 * descriptor carrying a `style` and the fixed `event` fields merged in when the
 * choice is selected.
 */
export type AgentInteractionEventMeta =
  | string
  | {
      label?: string;
      style?: string;
      event?: Record<string, unknown>;
    };

/** The `interaction` descriptor {@link getInteraction} reads off a state's meta. */
export interface AgentInteractionDescriptor {
  /** Label text, or a function of the machine context. `{path.to.field}` interpolates. */
  label?: string | ((args: { context: any }) => string);
  events?: Record<string, AgentInteractionEventMeta>;
  textEvent?: string;
}

/**
 * The state-meta shape the interaction protocol reads. Use it as the `meta`
 * type when the machine's only metadata is an interaction; see
 * {@link interactionMetaSchema} for the runtime schema.
 */
export interface AgentInteractionMeta {
  interaction?: AgentInteractionDescriptor;
}

function issue(message: string, path: (string | number)[]) {
  return { message, path };
}

// Validates one `meta.interaction.events` entry.
function validateEventMeta(value: unknown, path: (string | number)[]) {
  if (typeof value === "string") return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [issue("Expected a label string or an interaction event descriptor", path)];
  }
  const descriptor = value as Record<string, unknown>;
  const issues = [];
  if (descriptor["label"] !== undefined && typeof descriptor["label"] !== "string") {
    issues.push(issue("Expected a string", [...path, "label"]));
  }
  if (descriptor["style"] !== undefined && typeof descriptor["style"] !== "string") {
    issues.push(issue("Expected a string", [...path, "style"]));
  }
  const event = descriptor["event"];
  if (event !== undefined && (!event || typeof event !== "object" || Array.isArray(event))) {
    issues.push(issue("Expected an object of fixed event fields", [...path, "event"]));
  }
  return issues;
}

/**
 * A {@link StandardSchemaV1} for the state metadata {@link getInteraction}
 * reads: an object whose optional `interaction` declares a `label` (a string
 * with `{context.path}` interpolation, or a function of the context), an
 * `events` map of choices, and a `textEvent` for free-text answers. Pass it
 * straight to `createAgentSchemas({ meta: interactionMetaSchema })` instead of
 * restating the shape per machine.
 */
export const interactionMetaSchema: StandardSchemaV1<AgentInteractionMeta> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Expected a state meta object" }] };
      }
      const interaction = (value as Record<string, unknown>)["interaction"];
      if (interaction === undefined) {
        return { value: value as AgentInteractionMeta };
      }
      if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
        return { issues: [issue("Expected an interaction descriptor object", ["interaction"])] };
      }
      const descriptor = interaction as Record<string, unknown>;
      const issues = [];
      const label = descriptor["label"];
      if (label !== undefined && typeof label !== "string" && typeof label !== "function") {
        issues.push(issue("Expected a string or a (context) => string", ["interaction", "label"]));
      }
      const events = descriptor["events"];
      if (events !== undefined) {
        if (!events || typeof events !== "object" || Array.isArray(events)) {
          issues.push(issue("Expected an object keyed by event type", ["interaction", "events"]));
        } else {
          for (const [type, config] of Object.entries(events)) {
            issues.push(...validateEventMeta(config, ["interaction", "events", type]));
          }
        }
      }
      if (descriptor["textEvent"] !== undefined && typeof descriptor["textEvent"] !== "string") {
        issues.push(issue("Expected a string", ["interaction", "textEvent"]));
      }
      return issues.length > 0 ? { issues } : { value: value as AgentInteractionMeta };
    },
  },
};

/** Options for {@link getInteraction}. */
export interface GetInteractionOptions {
  /**
   * Keep label whitespace exactly as authored. Off by default: labels collapse
   * runs of whitespace to single spaces and trim, so a multi-line template
   * literal renders as one line and interpolated context cannot smuggle in
   * layout. Turn it on when the label is deliberately multi-line (a rendered
   * diff, a preformatted block).
   */
  preserveWhitespace?: boolean;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function interpolate(label: string, context: unknown, preserveWhitespace: boolean): string {
  const interpolated = label.replace(/\{([^{}]+)\}/g, (_, path: string) => {
    const value = readPath(context, path.trim());
    return value === undefined || value === null ? "" : String(value);
  });
  return preserveWhitespace ? interpolated : interpolated.replace(/\s+/g, " ").trim();
}

/** Reads the active state's interaction metadata and filters it through the
 * events XState currently accepts. Returns `undefined` when none is declared. */
export function getInteraction<TSnapshot extends AnyMachineSnapshot>(
  snapshot: TSnapshot,
  options: GetInteractionOptions = {},
): AgentInteraction<EventFromSnapshot<TSnapshot>> | undefined {
  const interaction = (getStateMeta(snapshot) as { interaction?: AgentInteractionDescriptor })
    .interaction;
  if (!interaction) return undefined;

  const preserveWhitespace = options.preserveWhitespace ?? false;
  const accepted = new Set(getAcceptedEvents(snapshot).map((event) => event.type));
  const label =
    typeof interaction.label === "function"
      ? interaction.label({ context: snapshot.context })
      : (interaction.label ?? "");
  const events = Object.entries(interaction.events ?? {})
    .filter(([type]) => accepted.has(type))
    .map(([type, config]) => {
      const descriptor = typeof config === "string" ? { label: config } : config;
      return [type, descriptor] as const;
    })
    // A choice's payload is its fixed fields, so ask the machine whether it
    // would take the event right now: a guard or a function transition
    // returning `undefined` hides the choice, and so does a targetless,
    // action-less transition (XState's `can` counts that as a no-op). A
    // choice whose schema needs fields the metadata does not fix cannot be
    // checked this way and stays rendered; the free-text event is never
    // checked because its payload is not known yet.
    .filter(([type, descriptor]) => {
      try {
        return snapshot.can({ ...(descriptor.event ?? {}), type } as never);
      } catch {
        return true;
      }
    })
    .map(([type, descriptor]) => {
      return {
        type,
        label: interpolate(descriptor.label ?? type, snapshot.context, preserveWhitespace),
        ...(descriptor.style ? { style: descriptor.style } : {}),
        ...(descriptor.event ? { event: descriptor.event } : {}),
      };
    });

  return {
    label: interpolate(label, snapshot.context, preserveWhitespace),
    events,
    ...(interaction.textEvent && accepted.has(interaction.textEvent)
      ? { textEvent: interaction.textEvent }
      : {}),
  } as AgentInteraction<EventFromSnapshot<TSnapshot>>;
}

/** Converts a rendered interaction choice back into a schema-validated machine
 * event. Fixed fields declared in metadata are merged before user fields. */
export function eventFromInteraction<TSnapshot extends AnyMachineSnapshot>(
  snapshot: TSnapshot,
  choice: ({ type: string } & Record<string, unknown>) | { text: string },
): EventFromSnapshot<TSnapshot> {
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
    event = { ...choice, ...descriptor.event, type: choice.type };
  }

  return parseAgentEvent(snapshot, event) as EventFromSnapshot<TSnapshot>;
}
