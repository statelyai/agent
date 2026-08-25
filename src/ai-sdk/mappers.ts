import {
  tool,
  type FlexibleSchema,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "ai";
import { getAgentOutputMode, type AgentCallUsage, type AgentTextRequest } from "../text-logic.js";
import { isStandardSchema } from "../utils.js";
import { renderDecisionAttempts } from "../decision.js";
import type { AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type { AgentTools, StandardSchemaV1 } from "../types.js";

/**
 * One call's usage as the adapter reports it: the AI SDK's `LanguageModelUsage`
 * plus the flat {@link AgentCallUsage} token fields core folds into a run's
 * aggregated usage.
 */
export type AiSdkCallUsage = LanguageModelUsage &
  Pick<AgentCallUsage, "reasoningTokens" | "cachedInputTokens">;

// Adapter-internal request/result mappers for the AI SDK adapter. NOT part of
// the public `@statelyai/agent/ai-sdk` entry point — `createAiSdkExecutors`
// (in ./index.ts) is the supported surface; these are imported by it and by
// the adapter's unit tests only.

/**
 * Maps an {@link AgentTools} map onto AI SDK `tool()` definitions. A tool that
 * already carries its own Standard Schema `inputSchema` — an AI SDK
 * `tool({...})`, or any equivalent descriptor — is passed through **unchanged**,
 * so the SDK applies its own validation, calls `execute(input, options)`, and
 * every extra property (`providerOptions`, `toModelOutput`, …) survives. A bare
 * `AgentToolExecute` function becomes a tool with an unconstrained input schema;
 * a minimal descriptor with no readable schema is converted with a permissive
 * fallback. Used by {@link toAiSdkCallSettings}.
 */
export function toAiSdkTools(tools: AgentTools) {
  const entries: Array<[string, Tool<unknown, unknown> | Tool<unknown, never>]> = [];

  for (const [name, descriptor] of Object.entries(tools)) {
    if (!descriptor) {
      continue;
    }

    if (typeof descriptor === "function") {
      entries.push([
        name,
        tool({
          inputSchema: unknownSchema,
          execute: (input) => descriptor(input),
        }),
      ]);
      continue;
    }

    // Native path: the tool already exposes a Standard Schema `inputSchema`
    // (the marker `tool({...})` leaves in place), so hand it to the SDK as-is —
    // the SDK owns its typing/validation/execute(input, options), and extras
    // ride along untouched. Only descriptors with no readable schema fall
    // through to the conversion path below.
    if (isStandardSchema(descriptor.inputSchema)) {
      entries.push([name, descriptor as unknown as Tool<unknown, unknown>]);
      continue;
    }

    const inputSchema =
      descriptor.inputSchema ??
      (descriptor.schemas as { input?: StandardSchemaV1 } | undefined)?.input;
    const toolOptions = {
      description: descriptor.description,
      inputSchema: inputSchema ? (inputSchema as FlexibleSchema<unknown>) : unknownSchema,
    };

    if (descriptor.execute) {
      entries.push([
        name,
        tool({
          ...toolOptions,
          execute: (input) => descriptor.execute?.(input),
        }),
      ]);
      continue;
    }

    entries.push([name, tool(toolOptions)]);
  }

  return Object.fromEntries(entries);
}

// Permissive fallback StandardSchemaV1/FlexibleSchema used for tools/events with no declared input schema.
const unknownSchema = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({}),
    },
  },
} as unknown as StandardSchemaV1 & FlexibleSchema<unknown>;

/**
 * Folds AI SDK v7's nested token details onto the flat field names core
 * aggregates. v7 moved `reasoningTokens` under `outputTokenDetails` and the
 * cached-input count under `inputTokenDetails.cacheReadTokens`, while
 * {@link AgentCallUsage} stays flat and provider-agnostic. The SDK's own shape
 * is spread through unchanged, so `onResult` consumers still see every field
 * the provider reported, including v7's `raw`.
 */
export function toAgentCallUsage(usage: LanguageModelUsage): AiSdkCallUsage {
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens;
  return {
    ...usage,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/**
 * AI SDK request-mapping settings shared by `generateText`/`streamText`.
 * `AgentTextRequest.messages` (`AgentMessage[]`) and AI SDK's `ModelMessage[]`
 * are structurally compatible by design (§1 of .scratch/p0-design.md) — the cast
 * below is a typed identity mapping, not a semantic conversion.
 */
export function toAiSdkCallSettings(request: AgentTextRequest & { tools?: AgentTools }) {
  const messages = request.messages as ModelMessage[] | undefined;
  return {
    system: request.system,
    // AI SDK v7 rejects `role: 'system'` inside `messages` unless a caller opts
    // in. An agent's messages are machine-authored server-side content (see the
    // `systemMessage()` helper), which is exactly the trusted case the flag is
    // for, so the opt-in rides along whenever the request uses `messages`.
    ...(messages ? { messages, allowSystemInMessages: true } : { prompt: request.prompt ?? "" }),
    reasoning: request.reasoning,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    topP: request.topP,
    topK: request.topK,
    seed: request.seed,
    stopSequences: request.stopSequences,
    tools: request.tools ? toAiSdkTools(request.tools) : undefined,
    toolChoice: toAiSdkToolChoice(request.toolChoice),
  };
}

/** Maps an {@link AgentToolChoice} to AI SDK's tool-choice shape — `{ type: 'tool'; name }` becomes `{ type: 'tool'; toolName }`; `'auto'`/`'none'`/`'required'`/`undefined` pass through unchanged. */
export function toAiSdkToolChoice(toolChoice: AgentTextRequest["toolChoice"]) {
  return typeof toolChoice === "object"
    ? { type: "tool" as const, toolName: toolChoice.name }
    : toolChoice;
}

/** `true` when the request should use AI SDK structured `Output.object`. */
export function isStructuredOutputRequest(
  request: Pick<AgentTextRequest, "outputSchema">,
): boolean {
  return getAgentOutputMode(request.outputSchema) === "structured";
}

/**
 * Extracts the first complete top-level JSON value from `text`, or returns
 * `undefined` when there is nothing to repair (no complete value, or the value
 * already spans the whole text). Models occasionally emit two structured-output
 * envelopes back to back (`{"result":{…}}{"result":{…}}`), which fails JSON
 * parsing wholesale; the balanced scan below recovers the first value and
 * drops the rest.
 */
export function extractFirstJsonValue(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        const value = text.slice(start, i + 1);
        return value === text.trim() ? undefined : value;
      }
    }
  }
  return undefined;
}

/** One AI SDK `tool()` per candidate event — the "tool-per-event +
 * toolChoice: 'required'" recipe from .scratch/p0-design.md §2.6. */
export function toAiSdkEventTools(events: AgentEventDescriptor[]): ToolSet {
  return Object.fromEntries(
    events.map((event) => [
      event.toolName,
      tool({
        description: `Choose the '${event.type}' move.`,
        inputSchema: event.inputSchema
          ? (event.inputSchema as FlexibleSchema<unknown>)
          : unknownSchema,
      }),
    ]),
  );
}

/**
 * Messages for a decision request, with prior failed `attempts` (§2.6)
 * rendered as appended user messages (via core's {@link renderDecisionAttempts})
 * so retries converge. Core never rewrites prompts — this is adapter business.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): ModelMessage[] | undefined {
  if (!request.messages && request.attempts.length === 0) {
    return undefined;
  }

  // A prompt-authored decision that is retrying must not lose its original
  // prompt when the request is lowered to messages for attempt feedback.
  const messages: ModelMessage[] = [
    ...((request.messages as ModelMessage[] | undefined) ??
      (request.prompt !== undefined ? [{ role: "user" as const, content: request.prompt }] : [])),
  ];
  for (const attempt of renderDecisionAttempts(request)) {
    messages.push({ role: "user", content: attempt.content as string });
  }
  return messages;
}
