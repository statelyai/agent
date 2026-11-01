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
 * - `'object'` (default): ONE structured-output object, `{ event: { type, ...payload } }`
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

/** Resolves a host's `decideMode` for one request; `'object'` by default. @internal */
export function resolveDecisionMode(
  option: DecisionModeOption | undefined,
  request: AgentDecisionRequest,
): DecisionMode {
  return (typeof option === "function" ? option(request) : option) ?? "object";
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
        anyOf: request.events.map((event) => eventBranch(event.type, event.inputSchema)),
      },
    },
    required: ["event"],
    additionalProperties: false,
  };
}

// One candidate: `type` pinned with a one-value `enum` (more widely supported
// than `const`), merged into an object payload schema, or alongside any other.
// The payload's own description is kept after the `Send '<type>'.` lead.
function eventBranch(
  type: string,
  inputSchema: AgentDecisionRequest["events"][number]["inputSchema"],
): Record<string, unknown> {
  const pinned = { type: "string", enum: [type] };
  const payload = markOptional(getJsonSchemaSync(inputSchema));
  const description =
    typeof payload?.description === "string"
      ? `Send '${type}'. ${payload.description}`
      : `Send '${type}'.`;
  if (!payload || isObjectSchema(payload)) {
    const properties = isRecord(payload?.properties) ? payload.properties : {};
    const required = Array.isArray(payload?.required) ? (payload.required as string[]) : [];
    const { $schema: _, ...rest } = payload ?? {};
    return {
      ...rest,
      type: "object",
      description,
      properties: { ...properties, type: pinned },
      required: ["type", ...required.filter((key) => key !== "type")],
    };
  }
  const { $schema: _, ...rest } = payload;
  return {
    description,
    allOf: [{ type: "object", properties: { type: pinned }, required: ["type"] }, rest],
  };
}

// Notes every optional property, at any depth, as one to leave out when the
// input does not give it. Without this, a model answering one object tends to
// pick a clarifying event over filling an unmentioned optional field.
function markOptional<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(markOptional) as T;
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = markOptional(value);
  if (isRecord(out.properties)) {
    const required = Array.isArray(out.required) ? out.required : [];
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) =>
        required.includes(key) || !isRecord(value)
          ? [key, value]
          : [
              key,
              {
                ...value,
                description: [OPTIONAL_NOTE, value.description].filter(Boolean).join(" "),
              },
            ],
      ),
    );
  }
  return out as T;
}

const OPTIONAL_NOTE = "Optional: leave out unless the input gives it.";

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === "object" &&
    schema.anyOf === undefined &&
    schema.oneOf === undefined &&
    schema.allOf === undefined
  );
}

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
