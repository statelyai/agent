import type { AnyMachineSnapshot } from "xstate";
import type { AgentMessage, AgentTools, ChosenEvent } from "../types.js";
import { assistantMessage, userMessage } from "../utils.js";
import { getAcceptedEvents, type AgentSchemas } from "../events.js";
import {
  normalizeGeneratorResult,
  type AgentRequestExecutor,
  type AgentTextRequest,
} from "../text-logic.js";
import {
  resolveDecision,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
} from "../decision.js";
import type { AgentRequest, AgentStepRequest } from "../steps.js";

// ─── State-request pass (the execution core of RunAgentOptions.getRequests) ───
//
// Extracted from runAgent so the pass — text calls, log bookkeeping, event
// advancement, ordering — is one unit, testable against a bare actor with no
// idle detection involved. runAgent supplies the host seams (snapshot/send,
// settle awareness, budgeted executors, tracing) through
// {@link StateRequestPassDeps} and keeps only the scheduling glue: when a
// pass starts, and what happens when it ends.

/**
 * One model request read off the machine's CURRENT snapshot by a
 * `RunAgentOptions.getRequests` hook. `model` is an executor model NAME — the
 * same string every {@link AgentTextRequest.model} carries, resolved by the
 * run's executors (e.g. a `defineModels` key when using
 * `createAiSdkExecutors`) — never a model instance.
 */
export interface AgentStateRequest {
  /** Instruction for this request's model call, appended to the run's message log as a user message. */
  prompt: string;
  /** System prompt for this request's model call(s). */
  system?: string;
  /** Executor model name (resolved by the run's executors). */
  model: string;
  /**
   * `'text'` (default): a `generateText` call with the message log +
   * `prompt`; the reply is appended to the log, then the machine is advanced
   * per {@link AgentStateRequest.onDone}. `'decision'`: no text call — a
   * single `decide` call (log + `prompt`) chooses the event. Use for pure
   * routing states.
   */
  kind?: "text" | "decision";
  /**
   * What to send when this request's text call resolves — the EXPLICIT
   * advancement contract, always an event OBJECT (the same shape
   * `actor.send` takes; no string shorthand). A literal event sends exactly
   * that; a function receives the text output (plus the live snapshot and
   * message log) and returns the event to send — payload included — or
   * `undefined` to send nothing. Omitted: a `decide` call chooses among the
   * candidate events (requires a `decide` executor) — there is no implicit
   * auto-send. A resolved event whose type the state does not accept throws
   * (programmer error); one a guard rejects is simply not sent. Ignored for
   * `kind: 'decision'` (the decide call IS the advancement).
   */
  onDone?:
    | ChosenEvent
    | ((args: {
        output: unknown;
        snapshot: AnyMachineSnapshot;
        messages: readonly AgentMessage[];
      }) => ChosenEvent | undefined);
  /** Restricts this request's candidate outcome events for the `decide` fallback (default: every currently-accepted event). */
  allowedEvents?: readonly string[];
  /** Trace/request id; defaults to `interpret_<n>`. */
  id?: string;
}

/** The request-lifecycle trace events a pass emits through {@link StateRequestPassDeps.onTrace}. */
type StateRequestTraceEvent =
  | { type: "request.start"; request: AgentStepRequest }
  | { type: "request.end"; request: AgentStepRequest; output: unknown; raw: unknown }
  | { type: "request.error"; request: AgentStepRequest; error: unknown };

/** The host seams a pass runs against — a live actor's snapshot/send, the shared message log, budgeted executors, and observation hooks. */
export interface StateRequestPassDeps {
  getSnapshot(): AnyMachineSnapshot;
  send(event: ChosenEvent): void;
  /** True once the host run has settled — the pass stops advancing (and stops appending). */
  isSettled(): boolean;
  /** The run's shared message log. The pass reads it for decide requests and `onDone` args. */
  messages: AgentMessage[];
  /** Appends to the shared log — the host's seam for `onMessage` observation. */
  appendToLog(...items: AgentMessage[]): void;
  generateText?: AgentRequestExecutor;
  /** The host's `decide` executor, pre-wrapped with its budget/trace counting. */
  decide?: AgentDecisionExecutor;
  /** Budget hook for text calls (decide calls count inside `decide` itself). */
  consumeModelCall(): void;
  /** Durable per-request id factory (`interpret_<n>` in runAgent). */
  nextRequestId(): string;
  onTrace?(event: StateRequestTraceEvent): void;
  onResult?(request: AgentStepRequest, result: { output: unknown; raw: unknown }): void;
  schemas?: AgentSchemas;
  signal?: AbortSignal;
}

// A pass runs in TWO phases so the message log is deterministic regardless
// of executor latency:
//
// 1. Text phase (concurrent): every request's `generateText` call runs
//    against the SAME pass-start log + its own prompt — siblings are
//    isolated from each other's in-flight output, so no request's history
//    depends on which sibling finished first.
// 2. Advance phase (sequential, in request order): each request's
//    prompt/reply block is appended to the shared log, then its event is
//    resolved (`onDone`, or a `decide` call that DOES see the blocks
//    appended before it) and sent. Sends and log order follow request
//    order, never completion order.
interface StateRequestPlan {
  stateRequest: AgentStateRequest;
  id: string;
  output: unknown;
  /** This request's own log contribution (prompt, and reply for text requests). */
  appended: AgentMessage[];
}

// Phase 1 for one request: the text call (skipped for kind: 'decision'),
// built from the frozen pass-start log.
async function runTextPhase(
  stateRequest: AgentStateRequest,
  baseMessages: readonly AgentMessage[],
  deps: StateRequestPassDeps,
): Promise<StateRequestPlan> {
  const { model, system } = stateRequest;
  const id = stateRequest.id ?? deps.nextRequestId();
  const promptMessage = userMessage(stateRequest.prompt);

  if (stateRequest.kind === "decision") {
    return { stateRequest, id, output: undefined, appended: [promptMessage] };
  }

  if (!deps.generateText) {
    throw new Error(
      "runAgent: a getRequests request needs a 'generateText' executor " +
        "(or use kind: 'decision').",
    );
  }
  const request: AgentTextRequest & { tools: AgentTools } = {
    model,
    ...(system !== undefined ? { system } : {}),
    messages: [...baseMessages, promptMessage],
    tools: {},
  };
  const agentRequest: AgentRequest = {
    kind: "text",
    id,
    src: "agent.interpret",
    mode: "generate",
    input: request,
    tools: {},
    events: [],
  };
  deps.consumeModelCall();
  deps.onTrace?.({ type: "request.start", request: agentRequest });
  let output: unknown;
  try {
    const raw = await deps.generateText(request, { signal: deps.signal });
    output = await normalizeGeneratorResult(raw, id, { request });
    deps.onResult?.(agentRequest, { output, raw });
    deps.onTrace?.({ type: "request.end", request: agentRequest, output, raw });
  } catch (error) {
    deps.onTrace?.({ type: "request.error", request: agentRequest, error });
    throw error;
  }
  return {
    stateRequest,
    id,
    output,
    appended: [
      promptMessage,
      assistantMessage(typeof output === "string" ? output : JSON.stringify(output)),
    ],
  };
}

// Phase 2 for one request: append its block to the shared log, resolve one
// legal event, send it. Returns true when an event was sent.
async function runAdvancePhase(
  plan: StateRequestPlan,
  deps: StateRequestPassDeps,
): Promise<boolean> {
  const { stateRequest, id, output } = plan;
  const { model, system } = stateRequest;
  deps.appendToLog(...plan.appended);

  // Advance the machine — explicit contract first: the request's own
  // `onDone` names (or computes, from the text output) the event to send.
  // No implicit auto-send lives in core; deterministic single-outcome
  // advancement is a RECIPE line (`onDone: { type: node.ownEvents[0] }`),
  // visible and editable at the call site.
  if (stateRequest.kind !== "decision" && stateRequest.onDone !== undefined) {
    const snapshot = deps.getSnapshot();
    const resolved =
      typeof stateRequest.onDone === "function"
        ? stateRequest.onDone({ output, snapshot, messages: deps.messages })
        : stateRequest.onDone;
    if (!resolved) {
      return false;
    }
    const acceptedTypes = getAcceptedEvents(snapshot, { schemas: deps.schemas }).map(
      (descriptor) => descriptor.type,
    );
    if (!acceptedTypes.includes(resolved.type)) {
      throw new Error(
        `runAgent: getRequests request '${id}' resolved onDone to event '${resolved.type}', ` +
          `which the current state does not accept. Accepted: ${
            acceptedTypes.join(", ") || "(none)"
          }.`,
      );
    }
    if (!snapshot.can(resolved)) {
      // Guard-rejected: nothing legal to send. The work is preserved in the
      // message log; the host settles idle when a whole pass sends nothing.
      return false;
    }
    deps.send(resolved);
    return true;
  }

  // Fallback (and the whole story for kind: 'decision'): a decision —
  // carrying the full message log, so the model chooses with this request's
  // work (and every earlier request's block) in view — picks one legal
  // event. Candidates are read off the LIVE snapshot (an earlier request in
  // this pass may have moved it), scoped by `allowedEvents`.
  const events = getAcceptedEvents(deps.getSnapshot(), {
    schemas: deps.schemas,
    ...(stateRequest.allowedEvents ? { eventTypes: stateRequest.allowedEvents } : {}),
  });
  if (events.length === 0) {
    return false;
  }
  if (!deps.decide) {
    throw new Error(
      "runAgent: a getRequests request without 'onDone' needs a 'decide' executor to " +
        `choose between events ${events.map((descriptor) => `'${descriptor.type}'`).join(", ")}. ` +
        "Provide request.onDone for deterministic advancement, or a 'decide' executor.",
    );
  }
  const decisionRequest: AgentDecisionRequest = {
    kind: "decision",
    id,
    model,
    ...(system !== undefined ? { system } : {}),
    messages: [...deps.messages],
    events,
    attempts: [],
  };
  const chosen = await resolveDecision(decisionRequest, deps.decide, {
    signal: deps.signal,
    canTake: (event) => deps.getSnapshot().can(event),
  });
  deps.appendToLog(assistantMessage(`[chose: ${chosen.type}]`));

  if (deps.isSettled()) {
    return false;
  }
  deps.send(chosen);
  return true;
}

/**
 * Executes one getRequests pass: all text calls concurrently against the
 * pass-start log, then per-request advancement sequentially in request
 * order. Returns whether ANY request sent an event — the host settles idle
 * when none did (otherwise an unchanged snapshot would re-produce the same
 * pass forever). Stops early (skipping remaining appends/sends) once
 * {@link StateRequestPassDeps.isSettled} reports the run is over. Throws on
 * executor/`onDone` errors — the host maps them to its error settle.
 */
export async function runStateRequestPass(
  requests: readonly AgentStateRequest[],
  deps: StateRequestPassDeps,
): Promise<{ sentAny: boolean }> {
  const baseMessages = [...deps.messages];
  const plans = await Promise.all(
    requests.map((stateRequest) => runTextPhase(stateRequest, baseMessages, deps)),
  );
  let sentAny = false;
  for (const plan of plans) {
    if (deps.isSettled()) {
      break;
    }
    sentAny = (await runAdvancePhase(plan, deps)) || sentAny;
  }
  return { sentAny };
}
