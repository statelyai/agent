// Plumbing the shipped executor adapters (`ai-sdk`, `openai`, `tanstack-ai`)
// share. Internal: no package entry point re-exports it. Each helper that
// throws takes the adapter's name (`'createOpenAiExecutors'`, …) so its error
// still says which adapter raised it.
import { AgentTruncatedError } from "../errors.js";
import { renderDecisionAttempts, type AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import {
  AGENT_USAGE_TOKEN_FIELDS,
  type AgentCallUsage,
  type AgentFinishReason,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
} from "../text-logic.js";
import type { AgentTool, ChosenEvent, ToolResultPart } from "../types.js";

/** Drops keys whose value is `undefined`, so a spread cannot erase what it lands on. */
export function defined<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

// ─── Text requests ───

/**
 * The tool-loop bound a request's `maxSteps` asks for: a whole number of at
 * least one, and one (single-step) when it is absent. A non-finite value (NaN,
 * Infinity) would never satisfy a step-count check and let a model that keeps
 * calling tools run unbounded, so it falls back to one too.
 */
export function normalizeMaxSteps(maxSteps: number | undefined): number {
  return typeof maxSteps === "number" && Number.isFinite(maxSteps)
    ? Math.max(1, Math.floor(maxSteps))
    : 1;
}

/**
 * Refuses a structured request on `streamText`. A chunk-by-chunk structured
 * object has nothing useful to hand `onChunk` mid-stream, so the request is
 * refused rather than silently downgraded to text.
 */
export function refuseStructuredStream(adapter: string): never {
  throw new Error(
    `${adapter}: streamText is text-only — a request declaring a structured output schema ` +
      "must be routed to generateText.",
  );
}

/**
 * The AgentTruncatedError an adapter throws when a structured request hit the
 * output token limit: its JSON never completed (or closed only because the
 * model stopped mid-thought), so there is nothing to hand a machine.
 */
export function truncated(
  adapter: string,
  request: AgentTextRequest,
  info: AgentRequestExecutorInfo | undefined,
  partialOutput?: unknown,
  cause?: unknown,
): AgentTruncatedError {
  return new AgentTruncatedError(
    `${adapter}: request '${request.name ?? "(unnamed)"}' hit the output token ` +
      "limit — its structured output never completed. Raise `maxOutputTokens`, shorten " +
      "the input, or ask for a smaller output schema.",
    {
      requestName: request.name ?? "(unnamed)",
      ...(info?.requestId !== undefined ? { requestId: info.requestId } : {}),
      ...(partialOutput !== undefined ? { partialOutput } : {}),
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

// ─── Messages and tools ───

/** Thrown for a message part the provider's messages cannot carry — dropping
 * it would silently change what the model sees. `target` names the provider
 * surface (`'Chat Completions'`, `'TanStack AI'`). */
export function unsupportedPart(
  adapter: string,
  target: string,
  role: string,
  type: string,
): never {
  throw new Error(
    `${adapter}: a ${role} message part of type '${type}' has no ${target} equivalent. Send ` +
      "text, image, tool-call, or tool-result parts, or convert it before the request.",
  );
}

/** Raw image bytes as a base64 string. Needs a global `btoa`, which every
 * runtime the adapters target has. */
export function toBase64(adapter: string, image: Uint8Array | ArrayBuffer): string {
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  const encode = (globalThis as { btoa?: (data: string) => string }).btoa;
  if (!encode) {
    throw new Error(
      `${adapter}: binary image parts need a global \`btoa\` to base64-encode. Pass the image ` +
        "as a URL or a base64 string instead.",
    );
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return encode(binary);
}

/** A `ToolResultPart`'s output as the string a provider tool message carries. */
export function toolResultContent(part: ToolResultPart): string {
  return part.output.type === "text" || part.output.type === "error-text"
    ? part.output.value
    : JSON.stringify(part.output.value);
}

/** A tool `description` may be a string or, for an AI SDK v7 tool, a function
 * of the call's context. A raw JSON payload can only carry the static form. */
export function staticDescription(descriptor: AgentTool): string | undefined {
  if (typeof descriptor === "function") {
    return undefined;
  }
  return typeof descriptor.description === "string" ? descriptor.description : undefined;
}

// ─── Decisions ───

/** The description of a decision's per-event tool (the "tool-per-event +
 * required tool choice" recipe). */
export function eventToolDescription(event: AgentEventDescriptor): string {
  return `Choose the '${event.type}' move.`;
}

/** A decision request's prior failed `attempts` (via core's
 * {@link renderDecisionAttempts}) as user messages to append, so retries
 * converge. Core never rewrites prompts — this is adapter business. */
export function decisionAttemptMessages(
  request: Pick<AgentDecisionRequest, "events" | "attempts" | "options">,
): { role: "user"; content: string }[] {
  return renderDecisionAttempts(request).map((attempt) => ({
    role: "user",
    content: attempt.content as string,
  }));
}

/** The candidate event whose tool a decision's tool call names. Throws when
 * the model called no tool (`toolName` is `undefined`) or an unknown one. */
export function eventForToolCall(
  adapter: string,
  events: readonly AgentEventDescriptor[],
  toolName: string | undefined,
): AgentEventDescriptor {
  if (toolName === undefined) {
    throw new Error(`${adapter}: decide — model did not call an event tool.`);
  }
  const event = events.find((candidate) => candidate.toolName === toolName);
  if (!event) {
    throw new Error(`${adapter}: decide — model called unknown tool '${toolName}'.`);
  }
  return event;
}

/**
 * The machine event a decision's tool call chose: the tool input's fields
 * plus the chosen event's own `type`, spread LAST so it always wins — a stray
 * `type` key in the model's tool input can never override the machine event
 * type. Payloads are flat under the event object, so a payload field named
 * `type` is unrepresentable: the event discriminant owns that slot.
 */
export function toChosenEvent(event: AgentEventDescriptor, input: unknown): ChosenEvent {
  return {
    ...(input && typeof input === "object" ? input : {}),
    type: event.type,
  } as ChosenEvent;
}

// ─── Results ───

/**
 * Adds two calls' usage together, field by field. A tool loop makes several
 * model calls per request, and core folds ONE `usage` per executor result into
 * the run's totals, so the steps' usages have to be summed or the run
 * undercounts. A field neither call reported stays absent.
 */
export function addAgentCallUsage(
  total: AgentCallUsage | undefined,
  next: AgentCallUsage | undefined,
): AgentCallUsage | undefined {
  if (!total || !next) {
    return total ?? next;
  }
  const sum: AgentCallUsage = {};
  for (const field of AGENT_USAGE_TOKEN_FIELDS) {
    if (total[field] !== undefined || next[field] !== undefined) {
      sum[field] = (total[field] ?? 0) + (next[field] ?? 0);
    }
  }
  return sum;
}

/** The `usage` key, present only when the provider reported one. */
export function usageField(usage: AgentCallUsage | undefined): { usage?: AgentCallUsage } {
  return usage ? { usage } : {};
}

/**
 * Maps a snake_case finish reason (OpenAI Chat Completions, TanStack AI) onto
 * the portable {@link AgentFinishReason}. `'function_call'` (OpenAI's
 * deprecated legacy path) joins `'tool_calls'` under `'tool-calls'`; anything
 * unrecognized, including a missing reason, lands on `'other'`. The provider's
 * own string stays on the result's `raw`.
 */
export function fromSnakeCaseFinishReason(
  finishReason: string | null | undefined,
): AgentFinishReason {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "other";
  }
}
