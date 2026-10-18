import type { AnyMachineSnapshot, AnyStateMachine, EventObject } from "xstate";
import {
  AgentInvalidEventPayloadError,
  getAcceptedEvents,
  parseAgentEvent,
  type EventFromSnapshot,
} from "./events.js";
import { getAgentExecutionOptions } from "./internal/registry.js";
import { getStateMeta } from "./utils.js";
import type { StandardSchemaV1 } from "./types.js";

export interface AgentInteractionEvent<TType extends string = string> {
  type: TType;
  label: string;
  style?: string;
  /** Optional fixed fields merged into the event when this choice is selected. */
  event?: Record<string, unknown>;
}

/** One payload choice {@link getInteraction} resolved: a label and the full event it sends. */
export interface AgentInteractionChoice<TEvent extends EventObject = EventObject> {
  label: string;
  event: TEvent;
  style?: string;
}

export interface AgentInteraction<TEvent extends EventObject = EventObject> {
  label: string;
  events: AgentInteractionEvent<TEvent["type"]>[];
  /**
   * Payload choices from `choices`, each a full event the snapshot accepts
   * right now. Present when the state declares `choices`.
   */
  choices?: AgentInteractionChoice<TEvent>[];
  /** Event type used for a free-text response. */
  textEvent?: TEvent["type"];
  /** The `textEvent` field the text fills, when it is not `text`. */
  textField?: string;
}

/** One payload choice as authored in `meta.interaction.choices`, inline or in a context array. */
export interface AgentInteractionChoiceMeta<TEvent extends string = string> {
  /** Button text. `{path.to.field}` interpolates from the context. */
  label: string;
  /** The full event the choice sends. */
  event: { type: TEvent; [key: string]: unknown };
  style?: string;
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

/**
 * The `interaction` descriptor {@link getInteraction} reads off a state's meta.
 * `TEvent` is the machine's event-type union, so a choice or `textEvent` that
 * names an event the machine never declared is a compile error.
 */
export interface AgentInteractionDescriptor<TEvent extends string = string> {
  /** Label text, or a function of the machine context. `{path.to.field}` interpolates. */
  label?: string | ((args: { context: any }) => string);
  events?: { [K in TEvent]?: AgentInteractionEventMeta };
  /**
   * Payload choices: one button per full event, such as one per seat or per
   * amount. A string is a context path to an array of the same shape,
   * computed at runtime.
   */
  choices?: AgentInteractionChoiceMeta<TEvent>[] | string;
  /**
   * The free-text event. A bare type puts the text in a `text` field;
   * `{ type, field }` names the field.
   */
  textEvent?: TEvent | { type: TEvent; field: string };
}

/**
 * The state-meta shape the interaction protocol reads. `setupAgent` types
 * every state's `meta` as this by default, with `TEvent` narrowed to the
 * machine's declared events; see {@link interactionMetaSchema} for the runtime
 * schema when a machine declares its own `meta` schema.
 */
export interface AgentInteractionMeta<TEvent extends string = string> {
  interaction?: AgentInteractionDescriptor<TEvent>;
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

// Validates one payload choice, authored statically or read from context.
function validateChoice(value: unknown, path: (string | number)[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [issue("Expected a { label, event } choice", path)];
  }
  const choice = value as Record<string, unknown>;
  const issues = [];
  if (typeof choice["label"] !== "string") {
    issues.push(issue("Expected a string", [...path, "label"]));
  }
  if (choice["style"] !== undefined && typeof choice["style"] !== "string") {
    issues.push(issue("Expected a string", [...path, "style"]));
  }
  const event = choice["event"];
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    typeof (event as { type?: unknown }).type !== "string"
  ) {
    issues.push(issue("Expected an event object with a string `type`", [...path, "event"]));
  }
  return issues;
}

/**
 * A {@link StandardSchemaV1} for the state metadata {@link getInteraction}
 * reads: an object whose optional `interaction` declares a `label` (a string
 * with `{context.path}` interpolation, or a function of the context), an
 * `events` map of choices, payload `choices` (an array, or a context path to
 * one), and a `textEvent` (a type, or `{ type, field }`) for free-text answers. This is
 * the default `meta` type `setupAgent` gives a machine; pass it to
 * `createAgentSchemas({ meta: interactionMetaSchema })` only when building a
 * schema pack by hand.
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
      const choices = descriptor["choices"];
      if (choices !== undefined && typeof choices !== "string") {
        if (!Array.isArray(choices)) {
          issues.push(
            issue("Expected an array of choices or a context path string", [
              "interaction",
              "choices",
            ]),
          );
        } else {
          choices.forEach((choice, index) => {
            issues.push(...validateChoice(choice, ["interaction", "choices", index]));
          });
        }
      }
      const textEvent = descriptor["textEvent"];
      if (
        textEvent !== undefined &&
        typeof textEvent !== "string" &&
        !(
          textEvent &&
          typeof textEvent === "object" &&
          typeof (textEvent as { type?: unknown }).type === "string" &&
          typeof (textEvent as { field?: unknown }).field === "string"
        )
      ) {
        issues.push(issue("Expected a string or { type, field }", ["interaction", "textEvent"]));
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

// The event schemas to judge payloads with: the pack `setupAgent` registered,
// else a plain machine's own `schemas.events`.
function eventSchemasOf(snapshot: AnyMachineSnapshot) {
  const machine = (snapshot as { machine?: AnyStateMachine }).machine;
  return (getAgentExecutionOptions(machine)?.schemas?.events ??
    (machine?.schemas as { events?: Record<string, StandardSchemaV1> } | undefined)?.events) as
    | Record<string, StandardSchemaV1>
    | undefined;
}

function isChoice(value: unknown): value is AgentInteractionChoiceMeta {
  return validateChoice(value, []).length === 0;
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
  // The machine's event schemas, so a choice's fixed payload can be judged
  // complete before the guard is consulted.
  const eventSchemas = eventSchemasOf(snapshot);
  const accepted = new Set(getAcceptedEvents(snapshot).map((event) => event.type));
  const label =
    typeof interaction.label === "function"
      ? interaction.label({ context: snapshot.context })
      : (interaction.label ?? "");
  const events = Object.entries(interaction.events ?? {})
    .filter(
      (entry): entry is [string, AgentInteractionEventMeta] =>
        entry[1] !== undefined && accepted.has(entry[0]),
    )
    .map(([type, config]) => {
      const descriptor = typeof config === "string" ? { label: config } : config;
      return [type, descriptor] as const;
    })
    // A choice's payload is its fixed fields. When those fields satisfy the
    // event's declared schema the payload is complete, so ask the machine
    // whether it would take the event right now: a guard or a function
    // transition returning `undefined` hides the choice, and so does a
    // targetless, action-less transition (XState's `can` counts that as a
    // no-op). When the schema needs fields the metadata does not fix, the
    // guard would only see `undefined`, so the check is skipped and the
    // choice stays rendered. The free-text event is never checked because
    // its payload is not known yet.
    .filter(([type, descriptor]) => {
      try {
        const complete = parseAgentEvent(
          snapshot,
          { ...descriptor.event, type },
          { events: eventSchemas },
        );
        return snapshot.can(complete as never);
      } catch {
        // Either the payload is incomplete for the schema, or no schema is
        // registered and a guard threw reading a field the metadata did not
        // fix. Both mean the choice cannot be judged here: keep it.
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

  // Payload choices carry their whole event, so each one is judged exactly:
  // a payload the schema refuses, or an event the machine would not take
  // right now, is left out.
  const declaresChoices = interaction.choices !== undefined;
  const declared =
    typeof interaction.choices === "string"
      ? readPath(snapshot.context, interaction.choices)
      : interaction.choices;
  const choices = (Array.isArray(declared) ? (declared as unknown[]) : [])
    .filter(isChoice)
    .filter((choice) => {
      try {
        const event = parseAgentEvent(snapshot, choice.event, { events: eventSchemas });
        return snapshot.can(event as never);
      } catch {
        return false;
      }
    })
    .map((choice) => ({
      label: interpolate(choice.label, snapshot.context, preserveWhitespace),
      event: choice.event,
      ...(choice.style ? { style: choice.style } : {}),
    }));

  const text =
    typeof interaction.textEvent === "string"
      ? { type: interaction.textEvent, field: "text" }
      : interaction.textEvent;

  return {
    label: interpolate(label, snapshot.context, preserveWhitespace),
    events,
    ...(declaresChoices ? { choices } : {}),
    ...(text && accepted.has(text.type)
      ? { textEvent: text.type, ...(text.field !== "text" ? { textField: text.field } : {}) }
      : {}),
  } as AgentInteraction<EventFromSnapshot<TSnapshot>>;
}

/**
 * Converts a rendered interaction answer back into a schema-validated machine
 * event:
 *
 * - `{ type, ...fields }` — an `events` choice; fixed fields declared in
 *   metadata win over user fields.
 * - `{ text }` — free text, placed in the `textEvent` field.
 * - `{ choice }` — a payload choice, by its index in `getInteraction(snapshot).choices`
 *   or by its label.
 */
export function eventFromInteraction<TSnapshot extends AnyMachineSnapshot>(
  snapshot: TSnapshot,
  choice:
    | ({ type: string } & Record<string, unknown>)
    | { text: string }
    | { choice: number | string },
): EventFromSnapshot<TSnapshot> {
  const interaction = getInteraction(snapshot);
  if (!interaction) {
    throw new AgentInvalidEventPayloadError(
      "(interaction)",
      "this state renders no interaction, so there is no choice to convert.",
    );
  }

  let event: { type: string } & Record<string, unknown>;
  if (!("type" in choice) && "choice" in choice) {
    const choices = interaction.choices ?? [];
    const key = choice.choice;
    const picked =
      typeof key === "number" ? choices[key] : choices.find(({ label }) => label === key);
    if (!picked) {
      throw new AgentInvalidEventPayloadError(
        "(choice)",
        `this interaction offers no choice ${JSON.stringify(key)}. Choices: ${
          choices.map(({ label }) => JSON.stringify(label)).join(", ") || "(none)"
        }.`,
      );
    }
    event = { ...picked.event };
  } else if ("text" in choice) {
    if (!interaction.textEvent) {
      throw new AgentInvalidEventPayloadError(
        "(text)",
        `this interaction takes no free text. Choices: ${
          interaction.events.map(({ type }) => type).join(", ") || "(none)"
        }.`,
      );
    }
    event = { type: interaction.textEvent, [interaction.textField ?? "text"]: choice.text };
  } else {
    const descriptor = interaction.events.find(({ type }) => type === choice.type);
    if (!descriptor) {
      throw new AgentInvalidEventPayloadError(
        choice.type,
        `this interaction does not offer that choice. Choices: ${
          interaction.events.map(({ type }) => type).join(", ") || "(none)"
        }.`,
      );
    }
    event = { ...choice, ...descriptor.event, type: choice.type };
  }

  return parseAgentEvent(snapshot, event, {
    events: eventSchemasOf(snapshot),
  }) as EventFromSnapshot<TSnapshot>;
}
