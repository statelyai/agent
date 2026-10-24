import type { AgentExecutorDecisionRequest } from "./decision.js";
import { isFirstDecision, statePaths, valueOf } from "./internal/trace-states.js";

/** One decision a run asked for. See {@link getDecisionRequests}. */
export interface TracedDecisionRequest {
  /** The active states when the decision was asked, as dot paths (one per parallel region). */
  states: string[];
  /** The request as the executor received it, on its first attempt. */
  request: AgentExecutorDecisionRequest;
}

/** Options for {@link getDecisionRequests}. */
export interface GetDecisionRequestsOptions {
  /** Keep only requests with this `name` (the `agent.decide` input's `name`). */
  name?: string;
}

/**
 * The decisions a run asked for, read from its trace: each decision's first
 * `request.start`, with the states the run was in. A trace is one run's events,
 * live or serialized with `serializeTraceEvent`. Retries of the same decision
 * are left out, so each decision appears once.
 *
 * Use the requests as eval rows (run a decider on each and compare its event
 * with a label) or as probe inputs for a policy. A serialized request keeps its
 * `options`, `metadata`, `system`, and `prompt`; event schemas do not survive
 * serialization, so replay closed choices (`options`) rather than open ones.
 *
 * @example
 * ```ts no-check
 * const rows = traces.flatMap((trace) => getDecisionRequests(trace, { name: "chooseResolution" }));
 * for (const { request } of rows) console.log((await decide(request)).event);
 * ```
 */
export function getDecisionRequests(
  trace: Iterable<{ readonly type: string }>,
  options: GetDecisionRequestsOptions = {},
): TracedDecisionRequest[] {
  const requests: TracedDecisionRequest[] = [];
  let current: string[] = [];
  for (const event of trace as Iterable<Record<string, unknown>>) {
    if (event.type === "machine.transition") {
      current = statePaths(valueOf(event.snapshot));
    } else if (event.type === "request.start" && isFirstDecision(event.request)) {
      if (options.name !== undefined && event.request.name !== options.name) continue;
      requests.push({
        states: [...current],
        request: event.request as unknown as AgentExecutorDecisionRequest,
      });
    }
  }
  return requests;
}
