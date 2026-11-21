import { AGENT_USAGE_TOKEN_FIELDS, type AgentCallUsage } from "../text-logic.js";

/**
 * Records on a thrown error how many provider calls its request made, and the
 * total usage of the responses it received, so the runtime counts a failed or
 * aborted tool loop's steps too (see `getCallModelCalls` and `getCallUsage`).
 * @internal
 */
export function withModelCalls(
  error: unknown,
  modelCalls: number,
  usage?: AgentCallUsage,
): unknown {
  if (typeof error === "object" && error !== null && Object.isExtensible(error)) {
    if (modelCalls > 1) (error as { modelCalls?: number }).modelCalls ??= modelCalls;
    // The adapter's total covers every response the request received. An SDK
    // error's own `usage` covers only the last one, so the total replaces it.
    if (usage) (error as { usage?: AgentCallUsage }).usage = usage;
  }
  return error;
}

/** Adds one response's token counts to a running total. @internal */
export function addCallUsage(
  total: AgentCallUsage | undefined,
  usage: Partial<Record<keyof AgentCallUsage, unknown>>,
): AgentCallUsage | undefined {
  for (const field of AGENT_USAGE_TOKEN_FIELDS) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      (total ??= {})[field] = (total[field] ?? 0) + value;
    }
  }
  return total;
}
