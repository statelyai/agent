/**
 * The step path: durable, per-model-call-checkpoint hosting of an agent
 * machine. Public vocabulary — `initialAgentStep`, `transitionAgentStep`,
 * `resolveAgentStep`, `getAgentRequests`, `executeAgentRequest`,
 * `resolveAgentRequests`.
 * @module
 */
import {
  initialTransition,
  transition,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type EventFromLogic,
  type ExecutableActionObjectFromLogic,
  type EventObject,
  type SnapshotFrom,
} from "xstate";
import type { AgentTools } from "./types.js";
import { validateSchemaSync } from "./utils.js";
import {
  executeAgentTextRequest,
  isTextLogic,
  type AgentRequestExecutors,
  type AgentRequestMode,
  type AgentTextRequest,
} from "./text-logic.js";
import {
  advancePlanLedger,
  isDecisionLogic,
  isPlanLogic,
  resolveDecision,
  PLAN_DONE_EVENT_TYPE,
  type AgentDecisionRequest,
  type AgentPlanInput,
  type AgentPlanOutput,
  type PlanLedgerContext,
  type PlanLedgerEvent,
  type PlanLedgerSnapshot,
  type PlanLogic,
} from "./decision.js";
import type { ChosenEvent } from "./types.js";
import {
  getAcceptedEvents,
  sanitizeEventToolName,
  type AgentEventDescriptor,
  type AgentRequestOptions,
  type AgentRequestSource,
} from "./events.js";
import {
  getRegisteredAgentExecutionOptions,
  type AgentExecutionOptions,
} from "./internal/registry.js";

/**
 * A pending text request surfaced by step discovery ({@link getAgentRequests}
 * / {@link AgentStep.requests}): the machine has spawned a
 * `TextLogic`-backed invoke and is waiting on its result. Resolve it with
 * {@link executeAgentRequest} (or by hand, then feed the output into
 * {@link resolveAgentStep} via `xstate.done.actor.<id>`).
 */
export interface AgentRequest<TInput extends AgentTextRequest = AgentTextRequest> {
  kind: "text";
  id: string;
  src: AgentRequestSource;
  mode?: AgentRequestMode;
  input: TInput;
  tools: AgentTools;
  events: AgentEventDescriptor[];
}

/**
 * A pending **plan** request re-surfaced by step discovery: the machine
 * invoked `agent.plan`, which applies an ordered sequence of legal events
 * (each one a decision) rather than a single one. Unlike text/decision
 * requests — surfaced once and resolved once — a plan request **re-surfaces on
 * every step** while the plan is in flight, its `events`/`applied`/
 * `stepsRemaining` updated each time, until it terminates.
 *
 * All fields are plain serializable data. Resolve ONE decision per step from
 * `events` (via {@link resolveDecision}, wiring `canTake` to
 * `snapshot.can` exactly like a single decision) then apply it: a real machine
 * event advances the plan (the next step re-surfaces this request); the
 * reserved `agent.plan.done` move, a `stopOn` event, an exhausted budget, or no
 * legal events completes it (its invoke resolves with `{ steps, stopped }`).
 * {@link resolveAgentRequests} does all of this natively — one decision (or one
 * completion) per call.
 *
 * The in-progress plan state (`applied` trail + remaining budget) lives in the
 * plan invoke child's own `createLogic` snapshot `context`
 * (`children.<id>.snapshot.context`), so it survives a full JSON
 * `getPersistedSnapshot` → restore round-trip: a host that persists the step
 * after every event and reloads resumes the plan identically.
 */
export interface AgentPlanRequest {
  kind: "plan";
  /** Durable invoke id of the `agent.plan` invoke. */
  id: string;
  /** Invoke src (`'agent.plan'` or a registered plan-logic source name). */
  src: AgentRequestSource;
  /** The resolved plan input (`model`/`system`/`prompt`/`allowedEvents`/`stopOn`/`maxSteps`/…). */
  input: AgentPlanInput;
  /**
   * The legal candidates for the NEXT plan step: the currently
   * snapshot-legal machine events (∩ declared `allowedEvents`) plus the
   * reserved `agent.plan.done` move.
   */
  events: AgentEventDescriptor[];
  /** The events applied so far in this plan, in order (the trail). */
  applied: ChosenEvent[];
  /** How many more events the plan may apply (`maxSteps - applied.length`). */
  stepsRemaining: number;
}

/** `AgentStep.requests` element: a text, decision, or plan request. */
export type AgentStepRequest = AgentRequest | AgentDecisionRequest | AgentPlanRequest;

interface InvokeEffectMetadata {
  id?: unknown;
  src?: unknown;
  input?: unknown;
  logic?: unknown;
}

/** @internal Normalizes current and legacy XState invoke effect shapes. */
export function getInvokeEffectMetadata(action: {
  type?: string;
  params?: unknown;
  id?: unknown;
  src?: unknown;
  input?: unknown;
  logic?: unknown;
}): InvokeEffectMetadata | undefined {
  if (action.type === "@xstate.spawn") {
    return action;
  }

  if (action.type === "xstate.spawnChild") {
    const params = action.params as InvokeEffectMetadata | undefined;
    return params ? { ...params, logic: action.logic } : undefined;
  }

  // Before spawn/start were split, @xstate.start carried invoke metadata.
  if (action.type === "@xstate.start" && typeof action.src === "string") {
    return action;
  }

  return undefined;
}

/**
 * Scans a set of executable actions (as returned by xstate's `transition`/
 * `initialTransition`) for spawned `TextLogic`/`DecisionLogic` invokes and
 * lowers each into an {@link AgentStepRequest}. The hand-passed-schemas
 * implementation detail behind the public {@link getAgentRequests} — it needs
 * `schemas`/`actorSources` passed explicitly, whereas `getAgentRequests`
 * pre-fills them from the machine's registered `setupAgent` options.
 * `options.snapshot` is required to resolve a decision's candidate events
 * (intersecting declared `allowedEvents` with what's currently legal) — omit
 * it and decision requests report an empty `events` list.
 *
 * @internal
 */
export function getAgentRequestsWith(
  actions: readonly {
    type?: string;
    params?: unknown;
    id?: unknown;
    src?: unknown;
    input?: unknown;
    logic?: unknown;
  }[],
  options: AgentRequestOptions = {},
): AgentStepRequest[] {
  const fromActions = actions.flatMap((action): AgentStepRequest[] => {
    const params = getInvokeEffectMetadata(action);
    if (!params || typeof params.src !== "string") {
      return [];
    }

    if (typeof params.id !== "string" || params.id.length === 0) {
      throw new Error(`Agent invoke '${params.src}' must define a durable string id.`);
    }

    const registeredLogic =
      isTextLogic(params.logic) || isDecisionLogic(params.logic)
        ? params.logic
        : options.actorSources?.[params.src];

    if (isDecisionLogic(registeredLogic)) {
      const decisionRequest = registeredLogic.request(params.input as never);
      // `undefined` (allowedEvents omitted) means "all legal events" — do
      // not default it to `[]` here or getAcceptedEvents will filter
      // everything out.
      const allowedEventTypes = (
        registeredLogic as unknown as {
          allowedEventTypes?: (input: unknown) => readonly string[] | undefined;
        }
      ).allowedEventTypes?.(params.input);
      const events = options.snapshot
        ? getAcceptedEvents(options.snapshot, {
            events: options.events,
            schemas: options.schemas,
            eventTypes: allowedEventTypes,
            eventToolName: options.eventToolName,
          })
        : [];

      return [
        {
          ...decisionRequest,
          id: params.id,
          events,
        },
      ];
    }

    const textLogic = isTextLogic(registeredLogic) ? registeredLogic : undefined;
    const input = textLogic ? textLogic.request(params.input as never) : undefined;

    if (!input) {
      return [];
    }

    return [
      {
        kind: "text",
        id: params.id,
        src: params.src,
        ...(textLogic ? { mode: textLogic.mode } : {}),
        input,
        tools: input.tools ?? {},
        events: [],
      },
    ];
  });

  // Plan requests are discovered from the live snapshot's children, not the
  // actions: an `agent.plan` invoke is spawned once but its request must
  // RE-SURFACE on every step until the plan terminates, and after the first
  // step its spawn no longer appears in `actions`. See getActivePlanRequests.
  return [...fromActions, ...getActivePlanRequests(options)];
}

/**
 * Scans the live snapshot's children for active `agent.plan` (plan-logic)
 * invokes and lowers each into an {@link AgentPlanRequest} — the re-surfacing
 * half of plan discovery. Reads the applied-event trail and remaining budget
 * from the child's own ledger `context` ({@link PlanLedgerContext}), recomputes
 * the currently-legal candidates (∩ declared `allowedEvents`) plus the reserved
 * `agent.plan.done` move, and takes `stepsRemaining` from the ledger (falling
 * back to `maxSteps - applied.length` for a snapshot with no context yet).
 * Returns `[]` when no snapshot is available (candidates need a live snapshot).
 *
 * @internal
 */
function getActivePlanRequests(options: AgentRequestOptions): AgentPlanRequest[] {
  const snapshot = options.snapshot;
  if (!snapshot) {
    return [];
  }
  const children = (snapshot as AnyMachineSnapshot & { children?: Record<string, unknown> })
    .children;
  if (!children) {
    return [];
  }

  const requests: AgentPlanRequest[] = [];
  for (const [id, child] of Object.entries(children)) {
    const ref = child as
      | {
          src?: unknown;
          logic?: unknown;
          getSnapshot?: () => { status?: unknown; input?: unknown; context?: unknown };
        }
      | undefined;
    if (typeof ref?.getSnapshot !== "function") {
      continue;
    }
    const src = typeof ref.src === "string" ? ref.src : undefined;
    const logic = (src ? options.actorSources?.[src] : undefined) ?? ref.logic;
    if (!isPlanLogic(logic)) {
      continue;
    }
    const childSnapshot = ref.getSnapshot();
    if (childSnapshot?.status !== "active") {
      continue;
    }

    // The in-progress plan state lives in the child ledger's own `context`.
    const input = (childSnapshot.input ?? {}) as unknown as AgentPlanInput;
    const maxSteps = input.maxSteps ?? 8;
    const ledger = (childSnapshot.context ?? {}) as Partial<PlanLedgerContext>;
    const applied = ledger.applied ?? [];
    const stepsRemaining = ledger.stepsRemaining ?? maxSteps - applied.length;

    const machineEvents = getAcceptedEvents(snapshot, {
      events: options.events,
      schemas: options.schemas,
      eventTypes: logic.allowedEventTypes(input as never) ?? undefined,
      eventToolName: options.eventToolName,
    });
    // Every step also offers the built-in "done" move (mirrors runAgent).
    const events = machineEvents.some((event) => event.type === PLAN_DONE_EVENT_TYPE)
      ? machineEvents
      : [
          ...machineEvents,
          { type: PLAN_DONE_EVENT_TYPE, toolName: sanitizeEventToolName(PLAN_DONE_EVENT_TYPE) },
        ];

    requests.push({
      kind: "plan",
      id,
      src: src ?? "",
      input,
      events,
      applied,
      stepsRemaining: Math.max(0, stepsRemaining),
    });
  }
  return requests;
}

/**
 * Builds the synthetic `xstate.done.actor.<id>` event xstate's `transition()`
 * expects to resolve a spawned invoke — the event {@link resolveAgentStep}
 * applies internally.
 *
 * @internal
 */
function doneEvent(
  request: Pick<AgentRequest, "id"> | string,
  output: unknown,
): { type: `xstate.done.actor.${string}`; output: unknown } {
  const id = typeof request === "string" ? request : request.id;
  return { type: `xstate.done.actor.${id}`, output };
}

/**
 * Applies a request's `output` as a done event via `transition(...)`,
 * returning the raw `[snapshot, actions]` tuple. Lower-level than
 * {@link resolveAgentStep} — that helper wraps this and also runs
 * {@link getAgentRequests} to produce the next {@link AgentStep}.
 *
 * @internal
 */
export function transitionResult<TLogic extends AnyActorLogic>(
  logic: TLogic,
  snapshot: SnapshotFrom<TLogic>,
  request: Pick<AgentRequest, "id"> | string,
  output: unknown,
): [SnapshotFrom<TLogic>, ExecutableActionObjectFromLogic<TLogic>[]] {
  const event = doneEvent(request, output);
  const result = transition(logic, snapshot, event as never);
  applyFinalStateOutput(logic, result[0], event);
  return result;
}

/**
 * One durable checkpoint on the step path: the machine's current snapshot,
 * the executable actions that produced it, the pending
 * {@link AgentStepRequest}s (text/decision work still to resolve), and
 * whether the machine has reached a final state. This is the
 * per-model-call-checkpoint path for durable hosts (Workflows, Temporal,
 * queues, …) — a peer of `runAgent`, not a lesser version of it. Produced by
 * {@link initialAgentStep}/{@link transitionAgentStep}/{@link resolveAgentStep}.
 */
export interface AgentStep<TSnapshot extends AnyMachineSnapshot = AnyMachineSnapshot> {
  snapshot: TSnapshot;
  actions: readonly { type?: string; params?: unknown }[];
  requests: AgentStepRequest[];
  done: boolean;
}

/**
 * Starts a machine and returns its first {@link AgentStep} — the step-path
 * equivalent of `initialTransition` plus request discovery. Begins the
 * durable/per-model-call-checkpoint loop: resolve each `step.requests` entry
 * (via {@link executeAgentRequest} for `kind: 'text'`, or
 * {@link resolveDecision} for `kind: 'decision'`), then advance with
 * {@link resolveAgentStep} or {@link transitionAgentStep}.
 */
export function initialAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  input?: unknown,
  options?: Partial<AgentExecutionOptions>,
): AgentStep<SnapshotFrom<TMachine>> {
  const [snapshot, actions] = initialTransition(machine, input as never);
  return createAgentStep(
    machine,
    snapshot,
    actions,
    getRegisteredAgentExecutionOptions(machine, options),
  );
}

/**
 * Applies an externally-sent event (e.g. a decision's chosen event, or a
 * human's reply) and returns the next {@link AgentStep}. Accepts **either**
 * a raw snapshot **or** a prior `AgentStep` as the second argument —
 * `.snapshot` is unwrapped automatically, so callers can thread the whole
 * step object through without manually plucking the snapshot out.
 */
export function transitionAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  snapshotOrStep: SnapshotFrom<TMachine> | AgentStep<SnapshotFrom<TMachine>>,
  event: EventFromLogic<TMachine>,
  options?: Partial<AgentExecutionOptions>,
): AgentStep<SnapshotFrom<TMachine>> {
  const snapshot = isAgentStep(snapshotOrStep) ? snapshotOrStep.snapshot : snapshotOrStep;
  const [nextSnapshot, actions] = transition(machine, snapshot, event as never);
  return createAgentStep(
    machine,
    nextSnapshot,
    actions,
    getRegisteredAgentExecutionOptions(machine, options),
  );
}

/**
 * Applies a resolved text request's output (a `kind: 'text'`
 * {@link AgentRequest} — not a decision) as a done event and returns the
 * next {@link AgentStep}. For decisions, resolve with `resolveDecision`
 * (which returns a {@link ChosenEvent}) and apply it with
 * {@link transitionAgentStep} instead — a decision has no output value of
 * its own to feed here.
 */
export function resolveAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  step: AgentStep<SnapshotFrom<TMachine>>,
  request: Pick<AgentRequest, "id"> | string,
  output: unknown,
  options?: Partial<AgentExecutionOptions>,
): AgentStep<SnapshotFrom<TMachine>> {
  const [snapshot, actions] = transitionResult(machine, step.snapshot, request, output);
  return createAgentStep(
    machine,
    snapshot,
    actions,
    getRegisteredAgentExecutionOptions(machine, options),
  );
}

/**
 * Snapshot in, requests out: scans executable actions for spawned agent
 * invokes and lowers each into an {@link AgentStepRequest}, pre-filled with
 * the machine's registered `setupAgent` schemas/actorSources (so callers
 * don't pass them by hand each call) — merged with any `options` passed here,
 * which take precedence. The step path's public discovery primitive;
 * `initialAgentStep`/`transitionAgentStep`/`resolveAgentStep` call it
 * internally to populate `AgentStep.requests`.
 */
export function getAgentRequests(
  machine: AnyActorLogic,
  actions: readonly { type?: string; params?: unknown }[],
  snapshot?: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, "eventToolName"> & Partial<AgentExecutionOptions> = {},
): AgentStepRequest[] {
  const machineOptions = getRegisteredAgentExecutionOptions(machine, options);

  return getAgentRequestsWith(actions, {
    ...machineOptions,
    ...options,
    snapshot,
  });
}

/**
 * Resolves one **text** {@link AgentRequest} against a host's
 * {@link AgentRequestExecutors} — merges the request's tools, dispatches to
 * `generateText`/`streamText` per `request.mode`, and validates the result
 * against `request.input.outputSchema` if present. **Text-only**: passing a
 * `kind: 'decision'` request throws, directing the caller to
 * `resolveDecision(request, executors.decide, ...)` instead. By default
 * returns the normalized output; pass `{ verbose: true }` to also get the
 * raw executor result (tool calls, usage, finish reason — needed for
 * observability and event-sourced replay).
 */
export function executeAgentRequest(
  request: AgentRequest,
  executors: Partial<AgentRequestExecutors>,
): Promise<unknown>;
export function executeAgentRequest(
  request: AgentRequest,
  executors: Partial<AgentRequestExecutors>,
  options: { verbose: true },
): Promise<{ output: unknown; raw: unknown }>;
export async function executeAgentRequest(
  request: AgentRequest,
  executors: Partial<AgentRequestExecutors>,
  options?: { verbose?: boolean },
): Promise<unknown> {
  if ((request as AgentStepRequest).kind === "decision") {
    throw new Error(
      "executeAgentRequest(...) is text-only. Resolve a 'decision' request with " +
        "resolveDecision(request, executors.decide, ...) instead.",
    );
  }

  assertTextExecutor(request, executors);

  const { output, raw } = await executeAgentTextRequest(
    request.mode ?? "generate",
    request.id,
    request.input,
    executors,
    request.tools,
  );

  const normalizedOutput = request.input.outputSchema
    ? validateSchemaSync(request.input.outputSchema, output)
    : output;

  return options?.verbose ? { output: normalizedOutput, raw } : normalizedOutput;
}

/**
 * Options for {@link resolveAgentRequests}.
 */
export interface ResolveAgentRequestsOptions extends Partial<AgentExecutionOptions> {
  /** Retries per decision, passed to `resolveDecision`. Default `2`. */
  maxRetries?: number;
}

/**
 * Resolves the current step's pending requests and returns the next
 * {@link AgentStep} — one iteration of the durable step loop, collapsing the
 * manual `request.kind` dispatch a host would otherwise write by hand.
 *
 * For each pending request, in order: a `kind: 'text'` request is run with
 * {@link executeAgentRequest} then fed back via {@link resolveAgentStep}; a
 * `kind: 'decision'` request is resolved with `resolveDecision` (wiring
 * `canTake` to `step.snapshot.can` so guard-rejected choices retry) then
 * applied with {@link transitionAgentStep}. The **current** step is re-read
 * after each application — the machine may advance and its `requests` change —
 * so this always resolves against the live step, never a stale list.
 *
 * A `kind: 'plan'` request (`agent.plan`) is resolved natively too: one plan
 * step per call. It resolves a single decision from `request.events` (wiring
 * `canTake` to `step.snapshot.can`, exempting the reserved `agent.plan.done`
 * move and `stopOn` events), then either applies the chosen machine event and
 * lets the next step re-surface the plan, or completes the plan (feeding its
 * `{ steps, stopped }` output back) on the done move / a `stopOn` event / an
 * exhausted budget / no legal events. The plan's applied trail is carried in
 * the invoke child's snapshot, so persisting the step between calls resumes the
 * plan identically.
 *
 * Missing the executor a request needs throws a clear error
 * (`generateText`/`streamText` for text, `decide` for decisions and plans).
 *
 * A complete durable host is two lines:
 *
 * ```ts
 * let step = initialAgentStep(machine, input);
 * while (!step.done) step = await resolveAgentRequests(machine, step, executors);
 * ```
 *
 * All pending **text** requests of a step are resolved in parallel
 * (`Promise.all`) — parallel statechart regions are genuinely concurrent, so
 * their model calls run concurrently — then their outputs apply in
 * **request-array order** (deterministic for durable replay regardless of which
 * call finishes first). Decisions and plans stay **one at a time**: applying
 * either changes the set of legal candidates for what follows, so they cannot be
 * resolved against a stale snapshot. A host that instead wants strictly
 * sequential text resolution loops the manual per-request helpers
 * ({@link executeAgentRequest} + {@link resolveAgentStep}) one at a time.
 */
export async function resolveAgentRequests<TMachine extends AnyActorLogic>(
  machine: TMachine,
  step: AgentStep<SnapshotFrom<TMachine>>,
  executors: Partial<AgentRequestExecutors>,
  options?: ResolveAgentRequestsOptions,
): Promise<AgentStep<SnapshotFrom<TMachine>>> {
  const [request] = step.requests;
  if (!request) {
    return step;
  }

  if (request.kind === "decision") {
    if (!executors.decide) {
      throw new Error(
        `this step's decision request '${request.id}' needs a 'decide' executor but none was provided.`,
      );
    }
    const chosenEvent = await resolveDecision(request, executors.decide, {
      canTake: (event: ChosenEvent) => (step.snapshot as AnyMachineSnapshot).can(event as never),
      maxRetries: options?.maxRetries,
    });
    return transitionAgentStep(machine, step, chosenEvent as EventFromLogic<TMachine>, options);
  }

  if (request.kind === "plan") {
    return resolvePlanRequest(machine, step, request, executors, options);
  }

  // Text requests. Decisions/plans above already returned, so every remaining
  // request here is text. Parallel statechart regions are concurrent, so all
  // pending text requests resolve in parallel; outputs then apply in
  // request-array order (deterministic for replay regardless of finish order).
  const textRequests = step.requests.filter(
    (candidate): candidate is AgentRequest => candidate.kind === "text",
  );
  for (const textRequest of textRequests) {
    assertTextExecutor(textRequest, executors);
  }
  const outputs = await Promise.all(
    textRequests.map((textRequest) => executeAgentRequest(textRequest, executors)),
  );
  let next = step;
  for (let index = 0; index < textRequests.length; index++) {
    next = resolveAgentStep(machine, next, textRequests[index]!, outputs[index], options);
  }
  return next;
}

// Throws the clear per-kind missing-executor error for a text request's mode —
// the descriptive style runAgent uses at bind time, naming the request src.
function assertTextExecutor(
  request: AgentRequest,
  executors: Partial<AgentRequestExecutors>,
): void {
  const mode = request.mode ?? "generate";
  const kind = mode === "stream" ? "streamText" : "generateText";
  const executor = mode === "stream" ? executors.streamText : executors.generateText;
  if (!executor) {
    throw new Error(
      `this step's text request '${request.src}' needs a '${kind}' executor but none was provided.`,
    );
  }
}

// Resolves ONE plan step: a terminal pre-check (budget/no-legal-events) or a
// single decision, then applies the chosen event and either re-surfaces the
// plan (next step) or completes it. See AgentPlanRequest for the protocol.
async function resolvePlanRequest<TMachine extends AnyActorLogic>(
  machine: TMachine,
  step: AgentStep<SnapshotFrom<TMachine>>,
  request: AgentPlanRequest,
  executors: Partial<AgentRequestExecutors>,
  options?: ResolveAgentRequestsOptions,
): Promise<AgentStep<SnapshotFrom<TMachine>>> {
  if (!executors.decide) {
    throw new Error(
      `this step's plan request '${request.src}' needs a 'decide' executor but none was provided.`,
    );
  }
  const stopOn = new Set<string>(request.input.stopOn ?? []);

  // Terminal pre-checks (no model call) — mirror runAgent's loop-top guards.
  if (request.stepsRemaining <= 0) {
    return completePlan(machine, step, request.id, request.applied, "max-steps", options);
  }
  const machineEvents = request.events.filter((event) => event.type !== PLAN_DONE_EVENT_TYPE);
  if (machineEvents.length === 0) {
    return completePlan(machine, step, request.id, request.applied, "no-legal-events", options);
  }

  const chosen = await resolveDecision(planStepDecisionRequest(request), executors.decide, {
    maxRetries: options?.maxRetries,
    canTake: (event: ChosenEvent) => {
      // The built-in done move and stopOn events terminate the plan rather
      // than driving a transition, so exempt both from the guard check.
      if (event.type === PLAN_DONE_EVENT_TYPE || stopOn.has(event.type)) {
        return true;
      }
      return (step.snapshot as AnyMachineSnapshot).can(event as never);
    },
  });

  if (chosen.type === PLAN_DONE_EVENT_TYPE) {
    return completePlan(machine, step, request.id, request.applied, "done", options);
  }

  const applied = [...request.applied, chosen];
  // Advance the plan child's own ledger (context) BEFORE the transition, so the
  // same (carried-forward) child ref re-surfaces the plan request with the
  // updated trail/budget on the next step.
  advancePlanChildLedger(step.snapshot as AnyMachineSnapshot, request.id, {
    type: "plan.applied",
    event: chosen,
  });
  const next = transitionAgentStep(machine, step, chosen as EventFromLogic<TMachine>, options);

  if (stopOn.has(chosen.type)) {
    // The stopOn event was applied; complete the plan — unless the event exited
    // the invoking state, which already canceled the invoke (onDone never fires).
    if (isPlanActive(next.snapshot as AnyMachineSnapshot, request.id)) {
      return completePlan(machine, next, request.id, applied, "stop-event", options);
    }
  }
  return next;
}

// Completes a plan by feeding its `{ steps, stopped }` output back as the
// invoke's done event (fires the machine's onDone, exactly like a text result).
function completePlan<TMachine extends AnyActorLogic>(
  machine: TMachine,
  step: AgentStep<SnapshotFrom<TMachine>>,
  id: string,
  steps: ChosenEvent[],
  stopped: AgentPlanOutput["stopped"],
  options?: ResolveAgentRequestsOptions,
): AgentStep<SnapshotFrom<TMachine>> {
  const output: AgentPlanOutput = { steps, stopped };
  return resolveAgentStep(machine, step, { id }, output, options);
}

// Builds the per-step decision request from a plan request: mirrors runAgent's
// createRunAgentPlanLogic — id `${id}[n]`, the trail appended to the prompt, and
// the built-in done-move hint.
function planStepDecisionRequest(request: AgentPlanRequest): AgentDecisionRequest {
  const { input, applied, events, id } = request;
  const trail =
    applied.length === 0
      ? ""
      : `\n\nEvents already applied in this plan, in order:\n${applied
          .map((step) => JSON.stringify(step))
          .join("\n")}\nContinue from here; do not repeat applied events.`;
  const doneHint = `\n\nWhen the request is fully handled (or no action is needed), choose '${PLAN_DONE_EVENT_TYPE}'.`;
  return {
    kind: "decision",
    id: `${id}[${applied.length}]`,
    model: input.model,
    system: input.system,
    prompt: `${input.prompt ?? ""}${trail}${doneHint}`,
    messages: input.messages,
    events,
    attempts: [],
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    topP: input.topP,
    topK: input.topK,
    seed: input.seed,
    stopSequences: input.stopSequences,
    metadata: input.metadata,
  };
}

// Advances the plan invoke child's own ledger snapshot in place: reads the
// child's current `createLogic` snapshot, applies one PlanLedgerEvent via the
// shared driver, and writes the result back onto the same snapshot reference
// (which xstate's Actor.getSnapshot() returns by identity, so the carried-
// forward child ref re-surfaces the plan with the updated context). The child's
// serialized `context` is the JSON-round-trippable carrier for in-progress plan
// state. No-op if the child/logic is missing.
function advancePlanChildLedger(
  snapshot: AnyMachineSnapshot,
  id: string,
  event: PlanLedgerEvent,
): void {
  const child = (snapshot as AnyMachineSnapshot & { children?: Record<string, unknown> })
    .children?.[id] as { logic?: unknown; getSnapshot?: () => unknown } | undefined;
  const childSnapshot = child?.getSnapshot?.();
  if (!isPlanLogic(child?.logic) || !childSnapshot || typeof childSnapshot !== "object") {
    return;
  }
  Object.assign(
    childSnapshot,
    advancePlanLedger(child.logic as PlanLogic, childSnapshot as PlanLedgerSnapshot, event),
  );
}

// True when the plan invoke child `id` is still active on `snapshot` (an
// applied event that exited its state removes/stops it).
function isPlanActive(snapshot: AnyMachineSnapshot, id: string): boolean {
  const child = (snapshot as AnyMachineSnapshot & { children?: Record<string, unknown> })
    .children?.[id] as { getSnapshot?: () => { status?: unknown } } | undefined;
  return child?.getSnapshot?.()?.status === "active";
}

// Assembles an AgentStep from a snapshot + actions: applies single-final-state output, then discovers pending requests.
function createAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  snapshot: SnapshotFrom<TMachine>,
  actions: readonly { type?: string; params?: unknown }[],
  options?: AgentExecutionOptions,
): AgentStep<SnapshotFrom<TMachine>> {
  applyFinalStateOutput(machine, snapshot);

  return {
    snapshot,
    actions,
    requests: getAgentRequestsWith(actions, {
      ...options,
      snapshot: snapshot as AnyMachineSnapshot,
    }),
    done: (snapshot as AnyMachineSnapshot).status === "done",
  };
}

// Walks a machine config by the snapshot's state `value` to find the reached final-state's config node.
function resolveStateValueConfig(config: { states?: Record<string, any> }, value: unknown): any {
  if (typeof value === "string") {
    return config.states?.[value];
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const childConfig = config.states?.[key];
    if (!childConfig) {
      continue;
    }

    if (childConfig.type === "final") {
      return childConfig;
    }

    const nested = resolveStateValueConfig(childConfig, childValue);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

// Backfills `snapshot.output` from the reached final state's `output` config when xstate didn't already set one (single-final-state root-output sugar — see setup-agent.ts's withRootOutputFromSingleFinal).
function applyFinalStateOutput(logic: AnyActorLogic, snapshot: unknown, event?: EventObject) {
  const machineSnapshot = snapshot as AnyMachineSnapshot & {
    output?: unknown;
    context?: unknown;
    value?: unknown;
  };

  if (
    machineSnapshot.status !== "done" ||
    machineSnapshot.output !== undefined ||
    !("config" in logic)
  ) {
    return;
  }

  const config = (logic as { config?: { states?: Record<string, any> } }).config;
  if (!config) {
    return;
  }

  const stateConfig = resolveStateValueConfig(config, machineSnapshot.value);
  const output = stateConfig?.output;
  if (output === undefined) {
    return;
  }

  machineSnapshot.output =
    typeof output === "function" ? output({ context: machineSnapshot.context, event }) : output;
}

// Duck-types an AgentStep vs a raw snapshot, for transitionAgentStep's dual-argument overload.
function isAgentStep<TSnapshot extends AnyMachineSnapshot>(
  value: unknown,
): value is AgentStep<TSnapshot> {
  return (
    !!value &&
    typeof value === "object" &&
    "snapshot" in value &&
    "actions" in value &&
    "requests" in value
  );
}
