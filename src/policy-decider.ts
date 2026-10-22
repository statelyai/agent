import type { AnyStateMachine, InputFrom } from "xstate";
import type { AgentDecisionExecutor, AgentExecutorDecisionRequest } from "./decision.js";
import { AgentError } from "./errors.js";
import { isRecord } from "./internal/is-record.js";
import { runAgent, type AgentRunOptions } from "./run-agent.js";

/** Options for {@link createPolicyDecider}: everything {@link runAgent} takes for the policy run, except how the run opens. */
export interface PolicyDeciderOptions<TPolicy extends AnyStateMachine> extends Omit<
  AgentRunOptions<TPolicy>,
  "input" | "event" | "attempts" | "snapshot" | "events" | "onIdle" | "signal"
> {
  /**
   * Builds the policy's input from the decision request. Default:
   * `{ facts: request.metadata?.facts, options, system: request.system, prompt: request.prompt }`,
   * where `options` are the offered events (`request.options[].event`). The
   * policy's input schema validates it.
   */
  input?: (request: AgentExecutorDecisionRequest) => InputFrom<TPolicy>;
}

/**
 * Runs a policy machine as a decide executor: each decision request starts one
 * run of `policy`, and its output is the chosen event. The policy can answer
 * with a rule (a `choice` over the facts, no model call) and invoke
 * `agent.decide` for the rest, answered by `options.executors`.
 *
 * The environment still judges the event: one it does not accept is retried
 * like any other decider's choice. The policy's token usage is reported on the
 * result, and left out when the policy made no model call. A run that does not
 * end `done` with an event throws `AgentError` with code `policy-not-done`.
 *
 * @example
 * ```ts no-check
 * const decide = createPolicyDecider(policyMachine, { executors: modelExecutors });
 * await runAgent(deskMachine, { input, executors: { ...modelExecutors, decide } });
 * ```
 */
export function createPolicyDecider<TPolicy extends AnyStateMachine>(
  policy: TPolicy,
  options: PolicyDeciderOptions<TPolicy> = {},
): AgentDecisionExecutor {
  const { input = defaultInput, ...runOptions } = options;
  return async (request, info) => {
    const result = await runAgent(policy, {
      ...(runOptions as AgentRunOptions<TPolicy>),
      input: input(request),
      ...(info?.signal ? { signal: info.signal } : {}),
    });
    const id = (policy.config as { id?: string }).id ?? policy.id;
    if (result.status !== "done") {
      const why = result.status === "error" ? `: ${String(result.error)}` : "";
      throw new AgentError("policy-not-done", `policy '${id}' settled '${result.status}'${why}`, {
        cause: result.status === "error" ? result.error : undefined,
      });
    }
    const event: unknown = result.output;
    if (!isRecord(event) || typeof event.type !== "string") {
      throw new AgentError(
        "policy-not-done",
        `policy '${id}' output is not an event: ${JSON.stringify(event)}`,
      );
    }
    const { modelCalls, ...usage } = result.usage;
    return { event: event as { type: string }, ...(modelCalls > 0 ? { usage } : {}) };
  };
}

function defaultInput<TPolicy extends AnyStateMachine>(
  request: AgentExecutorDecisionRequest,
): InputFrom<TPolicy> {
  const facts = (request.metadata as { facts?: unknown } | undefined)?.facts;
  // Absent keys stay absent: an `undefined` in a run's input keeps it from being journaled.
  return {
    ...(facts === undefined ? {} : { facts }),
    options: (request.options ?? []).map((option) => option.event),
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
  } as InputFrom<TPolicy>;
}
