import type { EventObject } from "xstate";
import type { AgentCallUsage } from "./text-logic.js";

/** Reserved event delivered after a model call reports token usage. */
export const AGENT_USAGE_EVENT_TYPE = "@agent.usage" as const;

/** Machine-owned usage signal. Handle it with an ordinary XState transition. */
export interface AgentUsageEvent extends EventObject {
  type: typeof AGENT_USAGE_EVENT_TYPE;
  usage: AgentCallUsage;
  kind?: "text" | "decision";
  id?: string;
  src?: string;
  model?: string;
  name?: string;
  /**
   * The run's model-call budget after this call: `modelCalls` counted against
   * `maxModelCalls` so far, including `modelCallsSpent`. Guard on
   * `maxModelCalls - modelCalls` to keep calls in reserve. Absent under
   * `provideExecutors`, which has no budget.
   */
  budget?: { modelCalls: number; maxModelCalls: number };
}
