import type { AnyStateMachine, InputFrom } from "xstate";
import type { AgentDecisionExecutor, AgentExecutorDecisionRequest } from "./decision.js";
import { AgentError } from "./errors.js";
import { assertJsonSerializable, canonicalEventJson } from "./event-log.js";
import { isRecord } from "./internal/is-record.js";
import { runAgent, type AgentRunOptions } from "./run-agent.js";
import type { AgentRequestExecutorInfo } from "./text-logic.js";

/** Options for {@link createPolicyDecider}: everything {@link runAgent} takes for the policy run, except how the run opens. */
export interface PolicyDeciderOptions<TPolicy extends AnyStateMachine> extends Omit<
  AgentRunOptions<TPolicy>,
  "input" | "event" | "attempts" | "snapshot" | "events" | "onIdle" | "signal" | "threadId"
> {
  /**
   * The `store` thread for one decision's policy run. Every decision, and every
   * retry of one, needs its own thread: a thread that already has entries is
   * resumed, so a shared one would return an earlier decision's choice. Default
   * with a `store`: `policy:${info.callKey}:${hash}`, where `hash` is the
   * SHA-256 of the policy input's canonical JSON. The call key is unique per call and attempt and stays the
   * same when a crashed run re-issues the call; the hash keeps a fork that asks
   * something else at the same call site off the parent's thread. Required
   * with a `store` when the decider is called without a `callKey`.
   */
  threadId?: (request: AgentExecutorDecisionRequest, info?: AgentRequestExecutorInfo) => string;
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
 * like any other decider's choice. The policy's input must be JSON (it opens
 * the policy run's event log): the default drops keys whose value is
 * `undefined`, and any other value that is not JSON throws before the run. The policy's token usage is reported on the
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
  const { input = defaultInput, threadId, ...runOptions } = options;
  const id = (policy.config as { id?: string }).id ?? policy.id;
  return async (request, info) => {
    const policyInput = input(request);
    assertJsonSerializable(policyInput, "policy input");
    const thread =
      runOptions.store === undefined ? undefined : await policyThread(request, policyInput, info);
    const result = await runAgent(policy, {
      ...(runOptions as AgentRunOptions<TPolicy>),
      input: policyInput,
      ...(thread === undefined ? {} : { threadId: thread }),
      ...(info?.signal ? { signal: info.signal } : {}),
    });
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

  async function policyThread(
    request: AgentExecutorDecisionRequest,
    policyInput: unknown,
    info?: AgentRequestExecutorInfo,
  ) {
    if (threadId) return threadId(request, info);
    // The call key names the call site, not the request: a fork shares it.
    if (info?.callKey)
      return `policy:${info.callKey}:${await sha256(canonicalEventJson(policyInput))}`;
    throw new AgentError(
      "missing-thread-id",
      `policy '${id}' has a store but no threadId, and the decision came with no callKey to derive one from`,
    );
  }
}

function defaultInput<TPolicy extends AnyStateMachine>(
  request: AgentExecutorDecisionRequest,
): InputFrom<TPolicy> {
  const facts = (request.metadata as { facts?: unknown } | undefined)?.facts;
  // An `undefined` anywhere in a run's input keeps it from being journaled; an absent key means the same.
  return withoutUndefinedKeys({
    facts,
    options: (request.options ?? []).map((option) => option.event),
    system: request.system,
    prompt: request.prompt,
  }) as InputFrom<TPolicy>;
}

/** A copy of `value` with every object key whose value is `undefined` removed, at any depth. */
function withoutUndefinedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefinedKeys);
  // Plain objects only: a Date or a class instance passes through for the JSON check to reject.
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, withoutUndefinedKeys(child)]),
  );
}

/** Hex SHA-256 of `text`, with Web Crypto (Node, browsers, workers). */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
