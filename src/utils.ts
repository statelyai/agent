import type {
  MachineConfig,
  StandardSchemaResult,
  StandardSchemaV1,
  StateConfig,
  StateValue,
  TransitionResult,
} from './types.js';

/** Internal state representation with dot-path string value */
export interface InternalState {
  value: string;
  context: Record<string, unknown>;
  status: 'active' | 'pending' | 'done' | 'error';
  params: Record<string, Record<string, unknown>>;
  output?: unknown;
  error?: unknown;
}

// ─── StateValue ↔ dot-path conversion ───

/** Convert xstate-style value `{ handling: 'check' }` to dot-path `'handling.check'` */
export function valueToPath(value: StateValue): string {
  if (typeof value === 'string') return value;
  const key = Object.keys(value)[0]!;
  const child = (value as Record<string, StateValue>)[key]!;
  return typeof child === 'string'
    ? `${key}.${child}`
    : `${key}.${valueToPath(child)}`;
}

/** Convert dot-path `'handling.check'` to xstate-style value `{ handling: 'check' }` */
export function pathToValue(path: string): StateValue {
  const parts = path.split('.');
  if (parts.length === 1) return parts[0]!;
  let result: StateValue = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i--) {
    result = { [parts[i]!]: result };
  }
  return result;
}

/**
 * Validate a value against a Standard Schema synchronously.
 * Throws if validation returns a Promise (async schemas not supported here).
 */
export function validateSchemaSync<T>(
  schema: StandardSchemaV1<T>,
  value: unknown
): T {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new Error(
      'Async schema validation is not supported in sync context. Validate input before calling getInitialState.'
    );
  }
  const syncResult = result as StandardSchemaResult<T>;
  if (syncResult.issues) {
    const messages = syncResult.issues
      .map((i: { message: string }) => i.message)
      .join(', ');
    throw new Error(`Validation failed: ${messages}`);
  }
  return syncResult.value as T;
}

/**
 * Resolve a StateConfig from a dot-separated state path.
 */
export function resolveStateConfig(
  config: MachineConfig<any, any, any, any>,
  value: string
): any {
  const parts = value.split('.');
  let current: Record<string, any> = config.states;
  let stateConfig: any;

  for (const part of parts) {
    stateConfig = current[part];
    if (!stateConfig) {
      throw new Error(`State '${part}' not found in path '${value}'`);
    }
    if (stateConfig.states) {
      current = stateConfig.states;
    }
  }

  return stateConfig!;
}

/**
 * Get the parent state config, or null for root states.
 */
export function getParentConfig(
  config: MachineConfig<any, any, any, any>,
  value: string
): any {
  const parts = value.split('.');
  if (parts.length <= 1) return null;
  const parentPath = parts.slice(0, -1).join('.');
  return resolveStateConfig(config, parentPath);
}

/**
 * Get the params for the current state.
 * Params are stored at `state.params[statePath]` when transitioning.
 * For nested states, also checks the parent path.
 */
export function getParams(
  valuePath: string,
  params: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  // Check own params first (set when transitioning TO this state)
  if (params[valuePath]) return params[valuePath]!;
  // Fall back to parent params (for compound state children)
  const parts = valuePath.split('.');
  if (parts.length <= 1) return {};
  const parentPath = parts.slice(0, -1).join('.');
  return params[parentPath] ?? {};
}

/**
 * Resolve an initial transition (string shorthand or function).
 */
export function resolveInitial(
  initial:
    | string
    | ((args: {
        context: Record<string, unknown>;
        params: Record<string, unknown>;
      }) => TransitionResult),
  args: {
    context: Record<string, unknown>;
    params: Record<string, unknown>;
  }
): TransitionResult {
  if (typeof initial === 'string') {
    return { target: initial };
  }
  return initial(args);
}

/**
 * Resolve a target relative to the handler's state path.
 * Targets are siblings of the state where the handler is defined.
 */
export function resolveTarget(
  handlerStatePath: string,
  target: string
): string {
  const parts = handlerStatePath.split('.');
  if (parts.length <= 1) return target;
  const parentParts = parts.slice(0, -1);
  return [...parentParts, target].join('.');
}

/**
 * Apply a transition result to produce a new state.
 */
export function applyTransition(
  config: MachineConfig<any, any, any, any>,
  state: InternalState,
  transition: TransitionResult,
  handlerStatePath: string
): InternalState {
  let newState = { ...state };

  if (transition.context) {
    newState.context = { ...state.context, ...transition.context };
  }

  if (transition.target) {
    newState.value = resolveTarget(handlerStatePath, transition.target);
    newState.status = 'active';

    if (transition.params) {
      newState.params = {
        ...state.params,
        [newState.value]: transition.params,
      };
    }

    newState = enterCompoundStates(config, newState);
  }

  return newState;
}

/**
 * If the current state is a compound state, resolve its initial and descend.
 */
export function enterCompoundStates(
  config: MachineConfig<any, any, any, any>,
  state: InternalState
): InternalState {
  let current = state;

  for (;;) {
    const stateConfig = resolveStateConfig(config, current.value);
    if (!stateConfig.states || !stateConfig.initial) break;

    const params = current.params[current.value] ?? {};
    const init = resolveInitial(stateConfig.initial, {
      context: current.context,
      params,
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
 * Collect available events for a state path.
 * State-level events override root-level events.
 * Only includes events that have handlers.
 */
export function getAvailableEvents(
  config: MachineConfig<any, any, any, any>,
  value: string
): Record<string, StandardSchemaV1> {
  const events: Record<string, StandardSchemaV1> = {};

  if (config.schemas?.events) {
    Object.assign(events, config.schemas.events);
  }

  const parts = value.split('.');
  for (let i = 0; i < parts.length; i++) {
    const path = parts.slice(0, i + 1).join('.');
    const stateConfig = resolveStateConfig(config, path);
    if (stateConfig.events) {
      Object.assign(events, stateConfig.events);
    }
  }

  const handledTypes = getHandledEventTypes(config, value);
  const result: Record<string, StandardSchemaV1> = {};
  for (const eventType of handledTypes) {
    if (events[eventType]) {
      result[eventType] = events[eventType];
    }
  }

  return result;
}

function getHandledEventTypes(
  config: MachineConfig<any, any, any, any>,
  value: string
): Set<string> {
  const handled = new Set<string>();
  const parts = value.split('.');

  for (let i = parts.length; i >= 1; i--) {
    const path = parts.slice(0, i).join('.');
    const stateConfig = resolveStateConfig(config, path);
    if (stateConfig.on) {
      for (const eventType of Object.keys(stateConfig.on)) {
        handled.add(eventType);
      }
    }
  }

  return handled;
}

/**
 * Find the event schema for a given event type.
 * State-level schemas override root-level.
 */
export function findEventSchema(
  config: MachineConfig<any, any, any, any>,
  value: string,
  eventType: string
): StandardSchemaV1 | undefined {
  const parts = value.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const path = parts.slice(0, i).join('.');
    const stateConfig = resolveStateConfig(config, path);
    if (stateConfig.events?.[eventType]) {
      return stateConfig.events[eventType];
    }
  }
  return config.schemas?.events?.[eventType];
}
