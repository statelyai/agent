import type {
  AgentMachine,
  AgentState,
  StandardSchemaResult,
  StandardSchemaV1,
  StateConfig,
  TransitionResult,
} from './types.js';

/**
 * Validate a value against a Standard Schema V1 schema.
 */
export async function validateSchema<T>(
  schema: StandardSchemaV1<T>,
  value: unknown
): Promise<T> {
  const result = await schema['~standard'].validate(value) as StandardSchemaResult<T>;
  if (result.issues) {
    const messages = result.issues.map((i: { message: string }) => i.message).join(', ');
    throw new Error(`Validation failed: ${messages}`);
  }
  return result.value as T;
}

/**
 * Resolve a StateConfig from a dot-separated state path.
 */
export function resolveStateConfig(
  machine: AgentMachine,
  value: string
): StateConfig {
  const parts = value.split('.');
  let current: Record<string, StateConfig> = machine.states;
  let config: StateConfig | undefined;

  for (const part of parts) {
    config = current[part];
    if (!config) {
      throw new Error(`State '${part}' not found in path '${value}'`);
    }
    if (config.states) {
      current = config.states;
    }
  }

  return config!;
}

/**
 * Get the parent state config for a nested state, or null for root states.
 */
export function getParentConfig(
  machine: AgentMachine,
  value: string
): StateConfig | null {
  const parts = value.split('.');
  if (parts.length <= 1) return null;
  const parentPath = parts.slice(0, -1).join('.');
  return resolveStateConfig(machine, parentPath);
}

/**
 * Get the parent's params for the current state.
 */
export function getParentParams(
  state: AgentState
): Record<string, unknown> {
  const parts = state.value.split('.');
  if (parts.length <= 1) return {};
  const parentPath = parts.slice(0, -1).join('.');
  return state.params[parentPath] ?? {};
}

/**
 * Resolve an initial transition value.
 * Accepts string shorthand, object shorthand, or function.
 */
export function resolveInitial(
  initial:
    | string
    | ((args: {
        context: Record<string, unknown>;
        parentParams: Record<string, unknown>;
      }) => TransitionResult),
  args: {
    context: Record<string, unknown>;
    parentParams: Record<string, unknown>;
  }
): TransitionResult {
  if (typeof initial === 'string') {
    return { target: initial };
  }
  return initial(args);
}

/**
 * Resolve a target state path. Targets are siblings of the handler's state.
 * `handlerStatePath` is the dot-path of the state where the handler is defined.
 */
export function resolveTarget(
  handlerStatePath: string,
  target: string
): string {
  const parts = handlerStatePath.split('.');
  if (parts.length <= 1) {
    // Handler on a root-level state → target is root-level
    return target;
  }
  // Handler on a nested state → target is a sibling (under same parent)
  const parentParts = parts.slice(0, -1);
  return [...parentParts, target].join('.');
}

/**
 * Apply a transition result to produce a new state.
 * Handles context merging, target resolution, and compound state entry.
 */
export function applyTransition(
  machine: AgentMachine,
  state: AgentState,
  transition: TransitionResult,
  handlerStatePath: string
): AgentState {
  let newState = { ...state };

  // Merge context
  if (transition.context) {
    newState.context = { ...state.context, ...transition.context };
  }

  if (transition.target) {
    // Resolve target relative to handler's scope
    newState.value = resolveTarget(handlerStatePath, transition.target);
    newState.status = 'running';

    // Store params if provided
    if (transition.params) {
      newState.params = {
        ...state.params,
        [newState.value]: transition.params,
      };
    }

    // Enter compound states recursively
    newState = enterCompoundStates(machine, newState);
  }

  return newState;
}

/**
 * If the current state is a compound state, resolve its initial and descend.
 * Repeats for nested compounds.
 */
export function enterCompoundStates(
  machine: AgentMachine,
  state: AgentState
): AgentState {
  let current = state;

  for (;;) {
    const config = resolveStateConfig(machine, current.value);
    if (!config.states || !config.initial) break;

    const parentParams = current.params[current.value] ?? {};
    const init = resolveInitial(config.initial, {
      context: current.context,
      parentParams,
    });

    if (!init.target) break;

    const childValue = `${current.value}.${init.target}`;
    current = { ...current, value: childValue };

    if (init.context) {
      current.context = { ...current.context, ...init.context };
    }
    if (init.params) {
      current.params = {
        ...current.params,
        [current.value]: init.params,
      };
    }
  }

  return current;
}

/**
 * Collect available events for a given state path.
 * Walks from the current state up to root, merging event schemas.
 * State-level events override root-level events.
 */
export function getAvailableEvents(
  machine: AgentMachine,
  value: string
): Record<string, StandardSchemaV1> {
  const events: Record<string, StandardSchemaV1> = {};

  // Root-level events
  if (machine.events) {
    Object.assign(events, machine.events);
  }

  // Walk up from current state, collecting event schemas
  const parts = value.split('.');
  for (let i = 0; i < parts.length; i++) {
    const path = parts.slice(0, i + 1).join('.');
    const config = resolveStateConfig(machine, path);
    if (config.events) {
      Object.assign(events, config.events);
    }
  }

  // Filter to only events that have handlers on the current state or ancestors
  const handledEvents = getHandledEventTypes(machine, value);
  const result: Record<string, StandardSchemaV1> = {};
  for (const eventType of handledEvents) {
    if (events[eventType]) {
      result[eventType] = events[eventType];
    }
  }

  return result;
}

/**
 * Get all event types that have handlers on the current state or any ancestor.
 */
function getHandledEventTypes(
  machine: AgentMachine,
  value: string
): Set<string> {
  const handled = new Set<string>();
  const parts = value.split('.');

  for (let i = parts.length; i >= 1; i--) {
    const path = parts.slice(0, i).join('.');
    const config = resolveStateConfig(machine, path);
    if (config.on) {
      for (const eventType of Object.keys(config.on)) {
        handled.add(eventType);
      }
    }
  }

  return handled;
}
