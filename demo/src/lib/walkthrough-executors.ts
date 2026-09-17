/**
 * Walkthrough executors — run ANY library example with no API key.
 *
 * The scripted executors in `scripted-executors.ts` know the eight demo
 * scenarios by name. The examples library is forty-odd machines the demo has
 * never seen, so these executors read only what every request carries: the
 * output schema of a text request, and the legal events (with their payload
 * schemas) of a decision. From that they synthesize a plausible, clearly
 * labelled placeholder, so the MACHINE runs for real — every state, guard,
 * retry budget and human wait — while the model's lines are stand-ins.
 *
 * Values are chosen to move a machine forward rather than stall it: booleans
 * are true, scores sit at the top of their range, decisions rotate through
 * the legal events so a loop that waits for a "finish" event reaches it.
 */
import type {
  AgentDecisionRequest,
  AgentRequestExecutorInfo,
  AgentRequestExecutors,
  AgentTextRequest,
} from "@statelyai/agent";
import { getJsonSchemaSync } from "@statelyai/agent";

export const WALKTHROUGH_NOTE =
  "No API key on the demo server: model replies are placeholders, the machine and its transitions are real.";

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  format?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  default?: unknown;
  nullable?: boolean;
};

/** Text of a framework-native message, whatever shape its content takes. */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof (part as { text?: unknown })?.text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join(" ");
  }
  return "";
}

/** First ~90 characters of the prompt's first meaningful line, for echoes. */
function gist(request: AgentTextRequest | AgentDecisionRequest): string {
  const messages: unknown[] = Array.isArray(request.messages) ? request.messages : [];
  const text =
    request.prompt ??
    messages
      .slice()
      .reverse()
      .map(messageText)
      .find((content: string) => content.trim()) ??
    "";
  const line = text
    .split("\n")
    .map((entry: string) => entry.trim())
    .find((entry: string) => entry && !/^[A-Za-z ]+:$/.test(entry));
  const short = unwrapPlaceholder(line ?? "").slice(0, 90);
  return short.length < unwrapPlaceholder(line ?? "").length ? `${short}…` : short;
}

/**
 * A placeholder fed back into a later prompt would otherwise nest forever
 * (“Placeholder for “Placeholder for “…”””). Dig out the original text.
 */
function unwrapPlaceholder(text: string): string {
  let current = text;
  for (let depth = 0; depth < 8; depth++) {
    // Innermost first: a quoted span with no quotes inside it.
    const next = current.replace(/Placeholder [^“”]*? for “([^“”]*)”\.?/g, "$1");
    if (next === current) break;
    current = next;
  }
  return current.replace(/…$/, "");
}

/** The first enum value the prompt mentions; a neutral middle otherwise; else the first. */
function pickEnum(values: unknown[], context: string): unknown {
  const words = context.toLowerCase();
  const mentioned = values.find(
    (value) => typeof value === "string" && value.length > 2 && words.includes(value.toLowerCase()),
  );
  if (mentioned !== undefined) return mentioned;
  const neutral = values.find(
    (value) =>
      typeof value === "string" && /^(neutral|medium|normal|question|other|general)$/i.test(value),
  );
  return neutral ?? values[0];
}

/** `$60`, `60 dollars` → 60; undefined when the prompt names no amount. */
function amountIn(context: string): number | undefined {
  const match =
    context.match(/\$\s*(\d+(?:\.\d{1,2})?)/) ??
    context.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b/i);
  return match ? Number(match[1]) : undefined;
}

/** A placeholder string that reads as what the field is for. */
function placeholderString(name: string, schema: JsonSchema, context: string): string {
  if (schema.format === "email") return "someone@example.com";
  if (schema.format === "uri" || schema.format === "url") return "https://example.com/placeholder";
  if (schema.format === "date-time") return new Date(0).toISOString();
  const key = name.toLowerCase();
  if (/reason|rationale|justification|why|explanation|feedback|critique|notes?$/.test(key)) {
    return "Placeholder rationale: the machine's structure is being walked through without a model.";
  }
  if (/question/.test(key)) return "Is it something you would find indoors?";
  if (/guess/.test(key)) return "a lighthouse";
  // Single-token slots: a game clue, a keyword. A sentence would fail the
  // machine's own "one word" checks, which is the machine's job, not ours.
  if (/^(word|clue|token|keyword|tag|term|category|topic)$/.test(key)) return "placeholder";
  if (/email|recipient|^to$/.test(key)) return "someone@example.com";
  if (/subject|title|name|label|headline/.test(key)) return `Placeholder ${key}`;
  if (/sql|query$/.test(key)) return "SELECT 1 AS placeholder;";
  if (/code|snippet|program|source/.test(key)) return "function placeholder() { return 0; }";
  if (/url|link/.test(key)) return "https://example.com/placeholder";
  if (/id$|key$|slug|handle/.test(key)) {
    // "order #8891" → "8891": lift an identifier the prompt already carries.
    return context.match(/#\s*([A-Za-z0-9-]{2,})/)?.[1] ?? "placeholder";
  }
  const about = context ? ` for “${context}”` : "";
  return `Placeholder ${key || "text"}${about}.`;
}

function placeholderNumber(name: string, schema: JsonSchema, context: string): number {
  const key = name.toLowerCase();
  const amount = amountIn(context);
  if (amount !== undefined && /amount|price|total|cost|charge|refund|cents/.test(key)) {
    return /cents/.test(key) ? Math.round(amount * 100) : amount;
  }
  const max =
    schema.maximum ??
    (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum - 1 : undefined);
  const min =
    schema.minimum ??
    (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined);
  // Scores and confidences sit high, so "good enough" loops complete; counts
  // and budgets sit low, so nothing explodes.
  if (/score|rating|confidence|quality|grade/.test(key)) {
    const high = max ?? 10;
    return min !== undefined ? Math.max(min, high) : high;
  }
  if (max !== undefined && min !== undefined) return Math.round((min + max) / 2);
  if (min !== undefined) return min;
  if (max !== undefined) return Math.min(max, 1);
  return 1;
}

/** Builds a value satisfying `schema`, named for the property it fills. */
export function synthesize(schema: JsonSchema | undefined, name = "", context = ""): unknown {
  if (!schema) return `Placeholder text for “${context}”.`;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return pickEnum(schema.enum, context);
  const union = schema.anyOf ?? schema.oneOf;
  if (union?.length) {
    // Prefer a non-null branch: `.nullable()` emits `anyOf: [T, null]`.
    const branch = union.find((entry) => entry.type !== "null") ?? union[0];
    return synthesize(branch, name, context);
  }
  if (schema.allOf?.length) {
    return Object.assign({}, ...schema.allOf.map((entry) => synthesize(entry, name, context)));
  }
  const type = Array.isArray(schema.type)
    ? (schema.type.find((entry) => entry !== "null") ?? schema.type[0])
    : schema.type;
  switch (type) {
    case "string":
      return placeholderString(name, schema, context);
    case "number":
    case "integer":
      return placeholderNumber(name, schema, context);
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const item = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      // Lists of problems stay empty so "is it good enough?" checks pass;
      // lists of work (steps, queries, candidates) get two entries so the
      // machine has something to fan out over.
      const empty =
        /missing|gaps?$|errors?|issues?|problems?|violations?|warnings?|failed|blockers?|todo/.test(
          name.toLowerCase(),
        );
      const count = Math.max(schema.minItems ?? (empty ? 0 : 2), 0);
      return Array.from({ length: count }, (_, index) =>
        synthesize(item, `${name}[${index}]`, context),
      );
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        out[key] = synthesize(property, key, context);
      }
      return out;
    }
    default:
      // No type: an untyped object or `unknown`. An object is the safest
      // guess for a structured slot; a string for anything else.
      return schema.properties
        ? synthesize({ ...schema, type: "object" }, name, context)
        : "placeholder";
  }
}

function toJsonSchema(schema: unknown): JsonSchema | undefined {
  try {
    return getJsonSchemaSync(schema as never) as JsonSchema | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Placeholder executors that satisfy any request's schemas.
 *
 * `turns` is the rotation memory for decisions: each invoke site cycles
 * through its legal events, so a loop that keeps asking eventually hears the
 * event that ends it. A run that spans several HTTP resumes must share one
 * map across them (the server keeps a module-level one), or every resume
 * would start the cycle over and pick the same event forever.
 */
export function createWalkthroughExecutors(
  turns: Map<string, number> = new Map(),
): Partial<AgentRequestExecutors> {
  const text = async (request: AgentTextRequest, info?: AgentRequestExecutorInfo) => {
    const schema = toJsonSchema(request.outputSchema);
    const output = schema
      ? synthesize(schema, request.name ?? "", gist(request))
      : `Placeholder reply for “${gist(request)}”.`;
    if (typeof output === "string" && info?.onChunk) {
      // Stream word by word so a streaming machine shows its chunks arriving.
      for (const word of output.split(/(?<=\s)/)) info.onChunk(word);
    }
    return { output };
  };

  return {
    generateText: text,
    streamText: text,
    decide: async (request: AgentDecisionRequest) => {
      const rejected = new Set(request.attempts.map((attempt) => attempt.event?.type));
      const candidates = request.events.filter((event) => !rejected.has(event.type));
      const pool = candidates.length ? candidates : request.events;
      if (!pool.length) {
        throw new Error("Walkthrough decision: the machine accepts no events in this state.");
      }
      const key = request.name ?? request.id ?? "decision";
      const turn = turns.get(key) ?? 0;
      turns.set(key, turn + 1);
      const chosen = pool[turn % pool.length];
      const payload = synthesize(toJsonSchema(chosen.inputSchema), chosen.type, gist(request));
      return {
        event: {
          ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
          type: chosen.type,
        },
      };
    },
  };
}
