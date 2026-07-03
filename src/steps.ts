import {
  initialTransition,
  transition,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type EventFromLogic,
  type ExecutableActionObjectFromLogic,
  type EventObject,
  type SnapshotFrom,
} from 'xstate';
import type { AgentTools, StandardSchemaV1 } from './types.js';
import { validateSchemaSync } from './utils.js';
import {
  executeAgentTextRequest,
  isTextLogic,
  type AgentRequestExecutors,
  type AgentRequestMode,
  type AgentTextRequest,
} from './text-logic.js';
import { isDecisionLogic, type AgentDecisionRequest } from './decision.js';
import {
  getAcceptedEvents,
  type AgentEventDescriptor,
  type AgentRequestOptions,
  type AgentRequestSource,
} from './events.js';
import {
  getRegisteredAgentExecutionOptions,
  type AgentExecutionOptions,
} from './internal/registry.js';

export interface AgentRequest<TInput extends AgentTextRequest = AgentTextRequest> {
  kind: 'text';
  id: string;
  src: AgentRequestSource;
  mode?: AgentRequestMode;
  input: TInput;
  tools: AgentTools;
  events: AgentEventDescriptor[];
}

/** `AgentStep.requests` element: a text request or a decision request. */
export type AgentStepRequest = AgentRequest | AgentDecisionRequest;

export function getAgentRequests(
  actions: readonly { type?: string; params?: unknown; id?: unknown; src?: unknown; input?: unknown; logic?: unknown }[],
  options: AgentRequestOptions = {}
): AgentStepRequest[] {
  return actions.flatMap((action): AgentStepRequest[] => {
    if (action.type !== 'xstate.spawnChild' && action.type !== '@xstate.start') {
      return [];
    }

    const params = action.type === '@xstate.start'
      ? action
      : action.params as
      | { id?: unknown; src?: unknown; input?: unknown }
      | undefined;
    if (!params || typeof params.src !== 'string') {
      return [];
    }

    if (typeof params.id !== 'string' || params.id.length === 0) {
      throw new Error(
        `Agent invoke '${params.src}' must define a durable string id.`
      );
    }

    const registeredLogic = isTextLogic(action.logic) || isDecisionLogic(action.logic)
      ? action.logic
      : options.actors?.[params.src];

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

      return [{
        ...decisionRequest,
        id: params.id,
        events,
      }];
    }

    const textLogic = isTextLogic(registeredLogic) ? registeredLogic : undefined;
    const input = textLogic
      ? textLogic.request(params.input as never)
      : undefined;

    if (!input) {
      return [];
    }

    return [{
      kind: 'text',
      id: params.id,
      src: params.src,
      ...(textLogic ? { mode: textLogic.mode } : {}),
      input,
      tools: input.tools ?? {},
      events: [],
    }];
  });
}

export function doneEvent(
  request: Pick<AgentRequest, 'id'> | string,
  output: unknown
): { type: `xstate.done.actor.${string}`; output: unknown } {
  const id = typeof request === 'string' ? request : request.id;
  return { type: `xstate.done.actor.${id}`, output };
}

export function transitionResult<TLogic extends AnyActorLogic>(
  logic: TLogic,
  snapshot: SnapshotFrom<TLogic>,
  request: Pick<AgentRequest, 'id'> | string,
  output: unknown
): [SnapshotFrom<TLogic>, ExecutableActionObjectFromLogic<TLogic>[]] {
  const event = doneEvent(request, output);
  const result = transition(logic, snapshot, event as never);
  applyFinalStateOutput(logic, result[0], event);
  return result;
}

export interface AgentStep<TSnapshot extends AnyMachineSnapshot = AnyMachineSnapshot> {
  snapshot: TSnapshot;
  actions: readonly { type?: string; params?: unknown }[];
  requests: AgentStepRequest[];
  done: boolean;
}

export function initialAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  input?: unknown,
  options?: Partial<AgentExecutionOptions>
): AgentStep<SnapshotFrom<TMachine>> {
  const [snapshot, actions] = initialTransition(machine, input as never);
  return createAgentStep(machine, snapshot, actions, getRegisteredAgentExecutionOptions(machine, options));
}

export function transitionAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  snapshotOrStep: SnapshotFrom<TMachine> | AgentStep<SnapshotFrom<TMachine>>,
  event: EventFromLogic<TMachine>,
  options?: Partial<AgentExecutionOptions>
): AgentStep<SnapshotFrom<TMachine>> {
  const snapshot = isAgentStep(snapshotOrStep)
    ? snapshotOrStep.snapshot
    : snapshotOrStep;
  const [nextSnapshot, actions] = transition(machine, snapshot, event as never);
  return createAgentStep(machine, nextSnapshot, actions, getRegisteredAgentExecutionOptions(machine, options));
}

export function resolveAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  step: AgentStep<SnapshotFrom<TMachine>>,
  request: Pick<AgentRequest, 'id'> | string,
  output: unknown,
  options?: Partial<AgentExecutionOptions>
): AgentStep<SnapshotFrom<TMachine>> {
  const [snapshot, actions] = transitionResult(machine, step.snapshot, request, output);
  return createAgentStep(machine, snapshot, actions, getRegisteredAgentExecutionOptions(machine, options));
}

export function getMachineAgentRequests(
  machine: AnyActorLogic,
  actions: readonly { type?: string; params?: unknown }[],
  snapshot?: AnyMachineSnapshot,
  options: Pick<AgentRequestOptions, 'eventToolName'> & Partial<AgentExecutionOptions> = {}
): AgentStepRequest[] {
  const machineOptions = getRegisteredAgentExecutionOptions(machine, options);

  return getAgentRequests(actions, {
    ...machineOptions,
    ...options,
    snapshot,
  });
}

export function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors
): Promise<unknown>;
export function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors,
  options: { verbose: true }
): Promise<{ output: unknown; raw: unknown }>;
export async function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors,
  options?: { verbose?: boolean }
): Promise<unknown> {
  if ((request as AgentStepRequest).kind === 'decision') {
    throw new Error(
      "executeAgentRequest(...) is text-only. Resolve a 'decision' request with " +
        'resolveDecision(request, executors.decide, ...) instead.'
    );
  }

  const { output, raw } = await executeAgentTextRequest(
    request.mode ?? 'generate',
    request.id,
    request.input,
    executors,
    request.tools
  );

  const normalizedOutput = request.input.outputSchema
    ? validateSchemaSync(request.input.outputSchema, output)
    : output;

  return options?.verbose
    ? { output: normalizedOutput, raw }
    : normalizedOutput;
}

function createAgentStep<TMachine extends AnyActorLogic>(
  machine: TMachine,
  snapshot: SnapshotFrom<TMachine>,
  actions: readonly { type?: string; params?: unknown }[],
  options?: AgentExecutionOptions
): AgentStep<SnapshotFrom<TMachine>> {
  applyFinalStateOutput(machine, snapshot);

  return {
    snapshot,
    actions,
    requests: getAgentRequests(actions, {
      ...options,
      snapshot: snapshot as AnyMachineSnapshot,
    }),
    done: (snapshot as AnyMachineSnapshot).status === 'done',
  };
}

function resolveStateValueConfig(
  config: { states?: Record<string, any> },
  value: unknown
): any {
  if (typeof value === 'string') {
    return config.states?.[value];
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const childConfig = config.states?.[key];
    if (!childConfig) {
      continue;
    }

    if (childConfig.type === 'final') {
      return childConfig;
    }

    const nested = resolveStateValueConfig(childConfig, childValue);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function applyFinalStateOutput(
  logic: AnyActorLogic,
  snapshot: unknown,
  event?: EventObject
) {
  const machineSnapshot = snapshot as AnyMachineSnapshot & {
    output?: unknown;
    context?: unknown;
    value?: unknown;
  };

  if (
    machineSnapshot.status !== 'done'
    || machineSnapshot.output !== undefined
    || !('config' in logic)
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
    typeof output === 'function'
      ? output({ context: machineSnapshot.context, event })
      : output;
}

function isAgentStep<TSnapshot extends AnyMachineSnapshot>(
  value: unknown
): value is AgentStep<TSnapshot> {
  return (
    !!value
    && typeof value === 'object'
    && 'snapshot' in value
    && 'actions' in value
    && 'requests' in value
  );
}
