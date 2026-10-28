import type { ChosenEvent } from "../types.js";

/**
 * A stand-in event for a decision answer that names no candidate event: no
 * tool call, a call to a tool that was not offered, or arguments that are not
 * JSON. Its `type` is no candidate event, so `resolveDecision` records it as a
 * failed `'unknown-event'` attempt (the type, which says what went wrong, is
 * the attempt's reason) and asks again. @internal
 */
export function unnamedEvent(
  toolCall: { toolName: string; invalidJson?: boolean } | undefined,
  toolNames: readonly string[],
): ChosenEvent {
  const valid = toolNames.join(", ") || "none";
  if (!toolCall) return { type: `no tool was called (call exactly one of: ${valid})` };
  if (toolCall.invalidJson) {
    return { type: `the arguments for tool '${toolCall.toolName}' were not valid JSON` };
  }
  return { type: `tool '${toolCall.toolName}' was not offered (valid tools: ${valid})` };
}
