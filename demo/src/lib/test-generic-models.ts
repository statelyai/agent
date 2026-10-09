/**
 * Test-only provider doubles for the demo's behavioral sweep. Never imported by
 * the app: the demo requires real keys, and this exists so the sweep can drive
 * every library example through the demo's real server path (provider →
 * AI SDK adapter → machine → chat result) without a network.
 *
 * Both doubles answer deterministically from the request itself:
 *   - The language model answers a structured request with a value synthesized
 *     from the JSON Schema the AI SDK sends, a decision with a tool call that
 *     rotates through the offered tools (so a loop waiting for a "finish" event
 *     reaches it), and a plain request with a short echo of the prompt.
 *   - The evaluation model answers a boolean with 0.9, a choice with its first
 *     label, and a score with its top level.
 *
 * `resetGenericModels()` restores the rotation, so each example starts from the
 * same state regardless of test order.
 */
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { Experimental_EvaluationModel } from "ai";

type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>;
type DoGenerate = Extract<MockOptions["doGenerate"], (...args: never[]) => unknown>;
type DoStream = Extract<MockOptions["doStream"], (...args: never[]) => unknown>;
type CallOptions = Parameters<DoGenerate>[0];
type StreamPart =
  Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer TPart> ? TPart : never;
type EvaluationModel = Extract<Experimental_EvaluationModel, { doEvaluate: unknown }>;
type EvaluateAnswer = Awaited<ReturnType<EvaluationModel["doEvaluate"]>>["answers"][string];

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  default?: unknown;
};

let decisionTurn = 0;

/** Restores the decision rotation; call before each example. */
export function resetGenericModels(): void {
  decisionTurn = 0;
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function fitString(text: string, schema: JsonSchema): string {
  let out = text;
  if (schema.maxLength !== undefined) out = out.slice(0, schema.maxLength);
  if (schema.minLength !== undefined && out.length < schema.minLength) {
    out = out.padEnd(schema.minLength, ".");
  }
  if (schema.pattern) {
    const pattern = new RegExp(schema.pattern, "u");
    if (!pattern.test(out)) {
      const candidate = ["mock", "Mock", "MOCK", "mock-1", "ABC123", "abc123", "1", "a"].find(
        (value) => pattern.test(value),
      );
      if (candidate) out = candidate;
    }
  }
  return out;
}

/** A value that satisfies `schema`, deterministically. */
export function synthesizeFromSchema(schema: unknown): unknown {
  return synthesize(schema as JsonSchema, "value", schema as JsonSchema);
}

function synthesize(schema: JsonSchema | undefined, key: string, root: JsonSchema): unknown {
  if (!schema) return null;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    return synthesize((root.$defs ?? root.definitions ?? {})[name], key, root);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants?.length) {
    const nonNull = variants.find((variant) => variant.type !== "null") ?? variants[0];
    return synthesize(nonNull, key, root);
  }
  if (schema.allOf?.length) {
    return Object.assign(
      {},
      ...schema.allOf.map((part) => synthesize(part, key, root) as Record<string, unknown>),
    );
  }
  const type = Array.isArray(schema.type)
    ? (schema.type.find((entry) => entry !== "null") ?? "null")
    : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        out[name] = synthesize(property, name, root);
      }
      return out;
    }
    case "array": {
      const count = Math.min(Math.max(schema.minItems ?? 1, 1), schema.maxItems ?? 1);
      if (schema.prefixItems?.length) {
        return schema.prefixItems.map((item, index) => synthesize(item, `${key}${index}`, root));
      }
      return Array.from({ length: count }, (_, index) =>
        synthesize(schema.items, `${key}${index}`, root),
      );
    }
    case "integer":
    case "number": {
      const max =
        schema.maximum ??
        (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum - 1 : undefined);
      const min =
        schema.minimum ??
        (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined);
      // Bounded fields (scores, indexes, days) take their top, so graders pass
      // their gates; unbounded ones take a small positive number.
      const value = max !== undefined && max < Number.MAX_SAFE_INTEGER ? max : (min ?? 1);
      return type === "integer" ? Math.floor(value) : value;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    case "string": {
      if (schema.format === "email") return "someone@example.com";
      if (schema.format === "uri" || schema.format === "url") return "https://example.com/mock";
      if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
      if (schema.format === "date") return "2026-01-01";
      return fitString(`mock ${key}`, schema);
    }
    default:
      return typeof schema.default !== "undefined" ? schema.default : `mock ${key}`;
  }
}

/** The last user-authored text in the prompt, for a readable echo. */
function lastUserText(options: CallOptions): string {
  for (const message of [...options.prompt].reverse()) {
    if (message.role !== "user") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}

function answer(options: CallOptions) {
  const tools = (options.tools ?? []).filter((tool) => tool.type === "function");
  // A decision: pick one offered tool, rotating so repeated decisions move on.
  if (tools.length > 0 && options.toolChoice?.type !== "none") {
    const tool = tools[decisionTurn % tools.length]!;
    decisionTurn += 1;
    const inputSchema = (tool as { inputSchema?: JsonSchema }).inputSchema ?? {};
    const input = synthesize(inputSchema, tool.name, inputSchema) ?? {};
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `call-${decisionTurn}`,
          toolName: tool.name,
          input: JSON.stringify(input),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      usage,
      warnings: [],
    };
  }
  const format = options.responseFormat;
  const text =
    format?.type === "json" && format.schema
      ? JSON.stringify(
          synthesize(format.schema as JsonSchema, "result", format.schema as JsonSchema),
        )
      : `Mock reply to: ${lastUserText(options).slice(0, 60)}`;
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage,
    warnings: [],
  };
}

/** A language model that answers every request from its own schema. */
export function genericLanguageModel(modelId = "mock-model"): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId,
    doGenerate: async (options) => answer(options),
    doStream: async (options) => {
      const generated = answer(options);
      const part = generated.content[0]!;
      const chunks: StreamPart[] =
        part.type === "text"
          ? [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              ...part.text
                .split(/(?<=\s)/)
                .map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: generated.finishReason, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              part,
              { type: "finish", finishReason: generated.finishReason, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/** An evaluation model that passes every gate the same way every time. */
export function genericEvaluationModel(): EvaluationModel {
  return {
    specificationVersion: "v4",
    provider: "mock-judge",
    modelId: "mock-judge",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doEvaluate: async (options) => {
      const answers: Record<string, EvaluateAnswer> = {};
      for (const [id, question] of Object.entries(options.questions)) {
        if (question.type === "boolean") {
          answers[id] = { type: "boolean", probability: 0.9 };
        } else if (question.type === "choice") {
          const labels = Object.keys(question.criteria);
          answers[id] = {
            type: "choice",
            choice: labels[0]!,
            probabilities: Object.fromEntries(
              labels.map((label, index) => [label, index === 0 ? 1 : 0]),
            ),
          };
        } else {
          const top = question.criteria.length - 1;
          answers[id] = {
            type: "score",
            score: top,
            probabilities: Object.fromEntries(
              question.criteria.map((_, index) => [String(index), index === top ? 1 : 0]),
            ),
          };
        }
      }
      return {
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
        providerMetadata: {
          typesafe: { confidence: Object.fromEntries(Object.keys(answers).map((id) => [id, 0.9])) },
        },
        response: { modelId: "mock-judge", timestamp: new Date(0) },
      };
    },
  };
}
