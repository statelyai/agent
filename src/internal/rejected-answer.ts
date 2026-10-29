import type { AgentDecisionRejection } from "../decision.js";

/**
 * The rejection for a decision answer that names no candidate event: no tool
 * call, a call to a tool that was not offered, or arguments that are not JSON.
 * `resolveDecision` records it as a failed attempt and asks again. @internal
 */
export function rejectedAnswer(
  toolCall: { toolName: string; invalidJson?: boolean } | undefined,
  toolNames: readonly string[],
): AgentDecisionRejection {
  const valid = toolNames.join(", ") || "none";
  if (!toolCall) {
    return {
      failure: "unknown-event",
      reason: `no tool was called; call exactly one of: ${valid}`,
    };
  }
  if (toolCall.invalidJson) {
    return {
      failure: "invalid-payload",
      reason: `the arguments for tool '${toolCall.toolName}' were not valid JSON`,
    };
  }
  return {
    failure: "unknown-event",
    reason: `tool '${toolCall.toolName}' was not offered; valid tools: ${valid}`,
  };
}
