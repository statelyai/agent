/**
 * The step path: durable, per-model-call-checkpoint hosting of an agent
 * machine. Public vocabulary — `initialAgentStep`, `transitionAgentStep`,
 * `resolveAgentStep`, `getAgentRequests`, `executeAgentRequest`.
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
import { isDecisionLogic, type AgentDecisionRequest } from "./decision.js";
import {
  getAcceptedEvents,
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

/** `AgentStep.requests` element: a text request or a decision request. */
export type AgentStepRequest = AgentRequest | AgentDecisionRequest;

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
  return actions.flatMap((action): AgentStepRequest[] => {
    if (action.type !== "xstate.spawnChild" && action.type !== "@xstate.start") {
      return [];
    }

    const params =
      action.type === "@xstate.start"
        ? action
        : (action.params as { id?: unknown; src?: unknown; input?: unknown } | undefined);
    if (!params || typeof params.src !== "string") {
      return [];
    }

    if (typeof params.id !== "string" || params.id.length === 0) {
      throw new Error(`Agent invoke '${params.src}' must define a durable string id.`);
    }

    const registeredLogic =
      isTextLogic(action.logic) || isDecisionLogic(action.logic)
        ? action.logic
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
}

/**
 * Builds the synthetic `xstate.done.actor.<id>` event xstate's `transition()`
 * expects to resolve a spawned invoke — the event {@link resolveAgentStep}
 * applies internally.
 *
 * @internal
 */
export function doneEvent(
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
  executors: AgentRequestExecutors,
): Promise<unknown>;
export function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors,
  options: { verbose: true },
): Promise<{ output: unknown; raw: unknown }>;
export async function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors,
  options?: { verbose?: boolean },
): Promise<unknown> {
  if ((request as AgentStepRequest).kind === "decision") {
    throw new Error(
      "executeAgentRequest(...) is text-only. Resolve a 'decision' request with " +
        "resolveDecision(request, executors.decide, ...) instead.",
    );
  }

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
