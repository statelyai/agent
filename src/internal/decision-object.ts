import {
  decisionOptionIds,
  type AgentDecisionOption,
  type AgentDecisionRejection,
  type AgentDecisionRequest,
} from "../decision.js";
import type { ChosenEvent } from "../types.js";
import { getJsonSchemaSync } from "../utils.js";
import { isRecord } from "./is-record.js";

/**
 * How a decide executor asks a language model for its one event:
 * - `'object'` (default for compatible payloads): ONE structured-output object, `{ event: { type, ...payload } }`
 *   (or `{ choice: id }` for a closed choice). Exactly one answer by construction.
 * - `'tool'`: one tool per candidate event under a forced tool choice. Parallel
 *   calls are turned off where the provider allows it, and an answer that still
 *   calls more than one tool is rejected and retried.
 */
export type DecisionMode = "object" | "tool";

/** A host's `decideMode` option: one mode, or one per request. @internal */
export type DecisionModeOption =
  | DecisionMode
  | ((request: AgentDecisionRequest) => DecisionMode | undefined);

/** Resolves a host's `decideMode`; incompatible object payloads default to `'tool'`. @internal */
export function resolveDecisionMode(
  option: DecisionModeOption | undefined,
  request: AgentDecisionRequest,
): DecisionMode {
  const configured = typeof option === "function" ? option(request) : option;
  if (configured) return configured;
  if (request.options) return "object";
  return request.events.every((event) => eventPayloadBranches(event.inputSchema) !== undefined)
    ? "object"
    : "tool";
}

/**
 * The JSON Schema of a decision answered as one object. An open choice is
 * `{ event }`, where `event` is any one candidate: its payload's properties
 * plus `type` pinned to the event type. A closed choice is `{ choice }`, an
 * enum of option ids (see {@link decisionOptionIds}). The root is always an
 * object, as providers' structured output requires. @internal
 */
export function decisionObjectSchema(
  request: Pick<AgentDecisionRequest, "events" | "options">,
): Record<string, unknown> {
  if (request.options) {
    const ids = decisionOptionIds(request.options);
    const lines = request.options.map((option, index) =>
      option.description ? `- ${ids[index]}: ${option.description}` : `- ${ids[index]}`,
    );
    return {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: ids,
          description: `The id of the one option you choose:\n${lines.join("\n")}`,
        },
      },
      required: ["choice"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {
      event: {
        description: "The one event to send next.",
        anyOf: request.events.flatMap((event) => eventBranches(event.type, event.inputSchema)),
      },
    },
    required: ["event"],
    additionalProperties: false,
  };
}

// One candidate: `type` pinned with a one-value `enum` (more widely supported
// than `const`), merged into an object payload schema, or alongside any other.
// The payload's own description is kept after the `Send '<type>'.` lead.
function eventPayloadBranches(
  inputSchema: AgentDecisionRequest["events"][number]["inputSchema"],
): Record<string, unknown>[] | undefined {
  if (!inputSchema) return [{}];
  // A schema with no synchronous JSON Schema cannot be described in one object.
  const payload = markOptional(getJsonSchemaSync(inputSchema));
  return payload ? objectBranches(payload) : undefined;
}

function objectBranches(schema: unknown): Record<string, unknown>[] | undefined {
  if (!isRecord(schema)) return undefined;
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const variants = union.map(objectBranches);
    if (variants.some((variant) => variant === undefined)) return undefined;
    return variants.flatMap((variant) => variant ?? []);
  }
  if (schema.allOf !== undefined) return undefined;
  return schema.type === "object" || isRecord(schema.properties) ? [schema] : undefined;
}

function eventBranches(
  type: string,
  inputSchema: AgentDecisionRequest["events"][number]["inputSchema"],
): Record<string, unknown>[] {
  const payloads = eventPayloadBranches(inputSchema);
  if (!payloads) {
    throw new Error(
      `Event '${type}' has a payload schema that cannot be represented in decision object mode; use decision tool mode instead.`,
    );
  }
  return payloads.map((payload) => eventBranch(type, payload));
}

function eventBranch(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const pinned = { type: "string", enum: [type] };
  const description =
    typeof payload.description === "string"
      ? `Send '${type}'. ${payload.description}`
      : `Send '${type}'.`;
  const properties = isRecord(payload.properties) ? payload.properties : {};
  const required = Array.isArray(payload.required)
    ? payload.required.filter((key): key is string => typeof key === "string")
    : [];
  const { $schema: _, ...rest } = payload;
  return {
    ...rest,
    type: "object",
    description,
    properties: { ...properties, type: pinned },
    required: ["type", ...required.filter((key) => key !== "type")],
  };
}

// Notes every optional property, at any depth, as one to leave out when the
// input does not give it. Without this, a model answering one object tends to
// pick a clarifying event over filling an unmentioned optional field.
function markOptional(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  const out: Record<string, unknown> = { ...schema };
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"] as const) {
    const children = schema[key];
    if (Array.isArray(children)) {
      out[key] = children.map((child) => markOptional(child) ?? child);
    }
  }
  for (const key of [
    "items",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "additionalProperties",
    "unevaluatedProperties",
  ] as const) {
    const child = schema[key];
    if (isRecord(child)) out[key] = markOptional(child) ?? child;
  }
  for (const key of ["$defs", "definitions", "patternProperties", "dependentSchemas"] as const) {
    const children = schema[key];
    if (!isRecord(children)) continue;
    out[key] = Object.fromEntries(
      Object.entries(children).map(([name, child]) => [name, markOptional(child) ?? child]),
    );
  }
  if (isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) =>
        required.includes(key) || !isRecord(value)
          ? [key, markOptional(value) ?? value]
          : [
              key,
              {
                ...(markOptional(value) ?? value),
                description: [OPTIONAL_NOTE, value.description].filter(Boolean).join(" "),
              },
            ],
      ),
    );
  }
  return out;
}

const OPTIONAL_NOTE = "Optional: leave out unless the input gives it.";

/**
 * Reads a decision answered as one object (see {@link decisionObjectSchema}):
 * the chosen event, or a rejection `resolveDecision` records and retries. A
 * string answer is parsed as JSON first. Payload validation is left to
 * `resolveDecision`. @internal
 */
export function fromDecisionObject(
  request: Pick<AgentDecisionRequest, "events" | "options">,
  answer: unknown,
): { event: ChosenEvent } | { rejected: AgentDecisionRejection } {
  let value = answer;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { rejected: { failure: "invalid-payload", reason: "the answer was not valid JSON" } };
    }
  }
  if (request.options) return fromChoice(request.options, value);

  const types = request.events.map((event) => event.type);
  const valid = types.join(", ") || "none";
  const event = isRecord(value) ? value.event : undefined;
  if (!isRecord(event) || typeof event.type !== "string") {
    return {
      rejected: {
        failure: "unknown-event",
        reason: `the answer named no event; answer with exactly one of: ${valid}`,
      },
    };
  }
  if (!types.includes(event.type)) {
    return {
      rejected: {
        failure: "unknown-event",
        reason: `'${event.type}' is not among the allowed events: ${valid}`,
        event: event as ChosenEvent,
      },
    };
  }
  return { event: event as ChosenEvent };
}

function fromChoice(
  options: readonly AgentDecisionOption[],
  value: unknown,
): { event: ChosenEvent } | { rejected: AgentDecisionRejection } {
  const ids = decisionOptionIds(options);
  const id = isRecord(value) ? value.choice : undefined;
  const option = typeof id === "string" ? options[ids.indexOf(id)] : undefined;
  return option
    ? { event: option.event }
    : {
        rejected: {
          failure: "unknown-event",
          reason: `option ${JSON.stringify(id)} was not offered; valid ids: ${ids.join(", ") || "none"}`,
        },
      };
}

/**
 * The rejection for a tool-mode answer that called more than one tool: a
 * decision sends exactly one event, so it is retried. @internal
 */
export function multipleCallsRejection(toolNames: readonly string[]): AgentDecisionRejection {
  return {
    failure: "unknown-event",
    reason: `a decision sends exactly one event, but ${toolNames.length} tools were called (${toolNames.join(", ")}); call exactly one`,
  };
}
