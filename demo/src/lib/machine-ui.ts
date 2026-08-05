/**
 * Client-safe vocabulary for the unified machine chat UI.
 *
 * The chat works with ANY machine via three ingredients read off the live
 * snapshot on the server:
 *
 * 1. `getAcceptedEvents(snapshot, { events: machine.schemas.events })` — what
 *    the machine accepts right now, each with an optional payload schema.
 * 2. JSON Schema per event (Standard Schema `~standard.jsonSchema` / Zod
 *    `z.toJSONSchema`) — drives the generated payload form.
 * 3. The `meta.interaction` convention — optional per-state hints authored in
 *    the machine definition:
 *
 *    ```ts
 *    meta: {
 *      interaction: {
 *        // Labels may reference runtime context with `{key}` placeholders,
 *        // resolved against `snapshot.context` when the state is presented
 *        // (e.g. "{notice} Another round?"). XState `meta` is static, so this
 *        // is how a label surfaces runtime state.
 *        label: "Amount exceeds the limit. Approve or deny.",
 *        events: {
 *          APPROVE: { label: "Approve refund", style: "primary" },
 *          DENY: { label: "Deny", style: "danger" },
 *        },
 *        // Free chat text becomes this event (payload from its single
 *        // string field). Without it, out-of-place text is not sent.
 *        textEvent: "REJECT",
 *        // Optional custom composer renderer for this state ("rating",
 *        // "cards"). Unknown names fall back to the schema form.
 *        component: "rating",
 *      },
 *    }
 *    ```
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type AcceptedEventStyle = "primary" | "danger" | "default";

export type AcceptedEvent = {
  type: string;
  /** Button label: interaction hint, else the humanized event type. */
  label: string;
  style: AcceptedEventStyle;
  /** JSON Schema of the event payload (sans `type`), when one is registered. */
  jsonSchema: JsonObject | null;
  /** True when sending this event needs user-provided payload fields. */
  needsPayload: boolean;
};

/** What an idle machine is waiting on — enough for a generic chat UI. */
export type ChatIdle = {
  /** Human prompt from `meta.interaction.label`, if declared. */
  prompt: string | null;
  events: AcceptedEvent[];
  /**
   * Event type that free chat text maps to while idle (its single string
   * field carries the text), from `meta.interaction.textEvent` or inferred
   * when exactly one accepted event takes exactly one string field.
   */
  textEvent: { type: string; field: string } | null;
  /**
   * Optional custom composer renderer name from
   * `meta.interaction.component` (e.g. "rating", "cards"). Null when the
   * state declares none; unknown names fall back to the schema form.
   */
  component: string | null;
};

/** "AUTO_REFUND" → "Auto refund". */
export function humanizeEventType(type: string): string {
  const words = type.replace(/[_.-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : type;
}

/**
 * Field/property name → readable label: splits camelCase, snake_case and
 * kebab-case, preserving ALL-CAPS acronyms ("maxRounds" → "Max rounds",
 * "playerHP" → "Player HP").
 */
export function humanizeFieldName(name: string): string {
  const tokens = name
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return name;
  return tokens
    .map((token, index) => {
      // Keep acronyms as authored ("HP", "URL"); otherwise sentence-case.
      if (token.length > 1 && token === token.toUpperCase() && /[A-Z]/.test(token)) return token;
      const lower = token.toLowerCase();
      return index === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

export type SchemaField = {
  name: string;
  label: string;
  required: boolean;
  description: string | null;
  kind:
    | { type: "string"; multiline: boolean }
    | { type: "number"; integer: boolean }
    | { type: "boolean" }
    | { type: "enum"; options: string[] }
    | { type: "json" };
  defaultValue: Json | undefined;
};

function fieldKind(schema: JsonObject): SchemaField["kind"] {
  const values = schema.enum;
  if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
    return { type: "enum", options: values as string[] };
  }
  switch (schema.type) {
    case "string": {
      const max = typeof schema.maxLength === "number" ? schema.maxLength : null;
      return { type: "string", multiline: max === null || max > 120 };
    }
    case "integer":
      return { type: "number", integer: true };
    case "number":
      return { type: "number", integer: false };
    case "boolean":
      return { type: "boolean" };
    default:
      // Nested objects, arrays, unions: raw JSON editor fallback.
      return { type: "json" };
  }
}

/**
 * Flattens an object JSON Schema into renderable form fields. Returns null
 * when the schema is not an object schema (the dialog then falls back to one
 * raw JSON field for the whole payload).
 */
export function schemaFields(schema: JsonObject): SchemaField[] | null {
  if (schema.type !== "object" && !schema.properties) return null;
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    label: humanizeFieldName(name),
    required: required.has(name),
    description: typeof property.description === "string" ? property.description : null,
    kind: fieldKind(property ?? {}),
    defaultValue: property?.default as Json | undefined,
  }));
}

/** True when the payload schema declares at least one property to fill in. */
export function schemaNeedsPayload(schema: JsonObject | null): boolean {
  if (!schema) return false;
  const fields = schemaFields(schema);
  if (fields === null) return true;
  return fields.length > 0;
}

/** The single string property name, when the schema is exactly that. */
export function singleStringField(schema: JsonObject | null): string | null {
  if (!schema) return null;
  const fields = schemaFields(schema);
  if (!fields || fields.length !== 1) return null;
  const [field] = fields;
  return field.kind.type === "string" ? field.name : null;
}
