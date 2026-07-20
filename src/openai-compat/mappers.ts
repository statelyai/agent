import { getJsonSchemaSync, isStandardSchema } from "../utils.js";
import { renderDecisionAttempts } from "../decision.js";
import type { AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type { AgentTextRequest } from "../text-logic.js";
import type { AgentTools } from "../types.js";

// Adapter-internal request/wire mappers for the OpenAI-compatible adapter. NOT
// part of the public `@statelyai/agent/openai-compat` entry point —
// `createOpenAiCompatExecutors` (in ./index.ts) is the supported surface;
// these are imported by it and by the adapter's unit tests only.

// ─── Wire types (minimal, local — no `openai` package) ───

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface WireTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

export interface WireResponse {
  choices?: WireChoice[];
  usage?: unknown;
}

// ─── Request → wire param mapping (pure, unit-testable) ───

/** Maps `AgentTextRequest.messages`/`system`/`prompt` to Chat Completions messages. */
export function toOpenAiMessages(
  request: Pick<AgentTextRequest, "system" | "prompt" | "messages">,
): WireMessage[] {
  if (request.messages) {
    return request.messages.flatMap((message): WireMessage[] => {
      const content = typeof message.content === "string" ? message.content : "";
      switch (message.role) {
        case "system":
          return [{ role: "system", content }];
        case "user":
          return [{ role: "user", content }];
        case "assistant":
          return [{ role: "assistant", content }];
        case "tool":
          // A `ToolMessage` carries one or more `ToolResultPart`s, each with
          // its own `toolCallId`; the wire tool role is one message per result.
          return message.content.map((part) => ({
            role: "tool" as const,
            content:
              part.output.type === "text" || part.output.type === "error-text"
                ? part.output.value
                : JSON.stringify(part.output.value),
            tool_call_id: part.toolCallId,
          }));
      }
    });
  }

  const messages: WireMessage[] = [];
  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push({ role: "user", content: request.prompt ?? "" });
  return messages;
}

/**
 * Maps sampling/stop settings. Targets `max_tokens` (not
 * `max_completion_tokens`) — it's the field every OpenAI-compatible backend
 * accepts (Ollama, vLLM, Groq, …), where `max_completion_tokens` is
 * OpenAI-only. Undefined fields are pruned so they never hit the wire.
 */
export function toOpenAiCallSettings(request: AgentTextRequest): Record<string, unknown> {
  return pruneUndefined({
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    top_p: request.topP,
    seed: request.seed,
    stop: request.stopSequences,
    // Chat Completions has no top_k parameter — dropped.
  });
}

/** One wire function tool per `AgentTools` entry. */
export function toOpenAiTools(tools: AgentTools): WireTool[] {
  return Object.entries(tools).flatMap(([name, descriptor]) => {
    if (!descriptor) {
      return [];
    }
    // Read only `description`/`inputSchema`; any extra fields an SDK-native
    // tool carries are ignored. A schema core can't read as Standard Schema
    // (an SDK-specific wrapper) yields empty `parameters` rather than crashing.
    const inputSchema = typeof descriptor === "function" ? undefined : descriptor.inputSchema;
    return [
      {
        type: "function" as const,
        function: {
          name,
          description: typeof descriptor === "function" ? undefined : descriptor.description,
          parameters:
            (isStandardSchema(inputSchema) ? getJsonSchemaSync(inputSchema) : undefined) ?? {},
        },
      },
    ];
  });
}

/** One wire function tool per candidate decision event — the
 * "tool-per-event + tool_choice: 'required'" recipe. */
export function toOpenAiEventTools(events: AgentEventDescriptor[]): WireTool[] {
  return events.map((event) => ({
    type: "function" as const,
    function: {
      name: event.toolName,
      description: `Choose the '${event.type}' move.`,
      parameters: getJsonSchemaSync(event.inputSchema) ?? {},
    },
  }));
}

/** Messages for a decision request, with prior failed `attempts` rendered as
 * appended user messages (via core's {@link renderDecisionAttempts}) so
 * retries converge. */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): WireMessage[] {
  const messages = toOpenAiMessages(request);
  for (const attempt of renderDecisionAttempts(request)) {
    messages.push({ role: "user", content: attempt.content as string });
  }
  return messages;
}

export function pruneUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
