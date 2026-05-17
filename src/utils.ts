import type {
  AgentMessage,
  AgentState,
  AgentToolChoice,
  InitialTransitionResult,
  MachineConfig,
  StandardSchemaResult,
  StandardSchemaV1,
  TransitionResult,
} from './types.js';

/**
 * Validate a value against a Standard Schema synchronously.
 */
export function validateSchemaSync<T>(
  schema: StandardSchemaV1<T>,
  value: unknown
): T {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new Error(
      'Async schema validation is not supported in sync context.'
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
 * Get the state config for a given state name.
 */
export function resolveStateConfig(
  config: MachineConfig,
  value: string
): StateConfigAny {
  const stateConfig = config.states[value];
  if (!stateConfig) {
    throw new Error(`State '${value}' not found`);
  }
  return stateConfig as StateConfigAny;
}

/** Loose state config for internal runtime use */
export type StateConfigAny = {
  type?: 'final';
  invoke?: (
    args: {
      context: Record<string, unknown>;
      messages: AgentMessage[];
      input: Record<string, unknown>;
    },
    enq: { emit(part: { type: string; [key: string]: unknown }): void }
  ) => Promise<unknown>;
  onDone?: (args: { output: unknown; context: Record<string, unknown>; messages: AgentMessage[] }) => TransitionResult;
  always?: TransitionResult | ((args: { context: Record<string, unknown>; messages: AgentMessage[]; input: Record<string, unknown> }, enq: { emit(part: { type: string; [key: string]: unknown }): void }) => TransitionResult);
  on?: Record<string, TransitionResult | ((args: { event: Record<string, unknown>; context: Record<string, unknown>; messages: AgentMessage[] }, enq: { emit(part: { type: string; [key: string]: unknown }): void }) => TransitionResult)>;
  output?: (args: { context: Record<string, unknown>; messages: AgentMessage[] }) => unknown;
  schemas?: {
    input?: StandardSchemaV1;
    output?: StandardSchemaV1;
  };
  model?: string | ((args: {
    snapshot: AgentState;
    context: Record<string, unknown>;
    messages: AgentMessage[];
    input: Record<string, unknown>;
  }) => string);
  adapter?: {
    generateText?: (...args: unknown[]) => Promise<unknown>;
  };
  prompt?: string | ((args: {
    snapshot: AgentState;
    context: Record<string, unknown>;
    messages: AgentMessage[];
    input: Record<string, unknown>;
  }) => string);
  system?: string | ((args: {
    snapshot: AgentState;
    context: Record<string, unknown>;
    messages: AgentMessage[];
    input: Record<string, unknown>;
  }) => string);
  tools?: Record<string, unknown> | ((args: {
    snapshot: AgentState;
    context: Record<string, unknown>;
    messages: AgentMessage[];
    input: Record<string, unknown>;
  }) => Record<string, unknown>);
  toolChoice?: AgentToolChoice | ((args: {
    snapshot: AgentState;
    context: Record<string, unknown>;
    messages: AgentMessage[];
    input: Record<string, unknown>;
  }) => unknown);
  events?: Record<string, StandardSchemaV1>;
};

/**
 * Get the input for the current state.
 */
export function getInput(
  value: string,
  input: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  return input[value] ?? {};
}

/**
 * Resolve an initial transition (string shorthand or function).
 */
export function resolveInitial(
  initial:
    | string
    | ((args: {
        context: Record<string, unknown>;
        input: Record<string, unknown>;
      }) => InitialTransitionResult),
  args: {
    context: Record<string, unknown>;
    input: Record<string, unknown>;
  }
): InitialTransitionResult {
  if (typeof initial === 'string') {
    return { target: initial };
  }
  return initial(args);
}

/**
 * Apply a transition result to produce a new state.
 */
export function applyTransition(
  state: AgentState,
  transition: TransitionResult
): AgentState {
  let newState = { ...state };

  if (transition.context) {
    newState.context = { ...state.context, ...transition.context };
  }

  if (transition.messages) {
    newState.messages = transition.messages;
  }

  if (transition.target) {
    newState.value = transition.target;
    newState.status = 'active';

    if (transition.input) {
      newState.input = {
        ...state.input,
        [transition.target]: transition.input,
      };
    }
  }

  return newState;
}

/**
 * Collect available events for a state.
 */
export function getAvailableEvents(
  config: MachineConfig,
  value: string
): Record<string, StandardSchemaV1> {
  const events: Record<string, StandardSchemaV1> = {};

  if (config.schemas?.events) {
    Object.assign(events, config.schemas.events);
  }

  const stateConfig = resolveStateConfig(config, value);
  if (stateConfig.events) {
    Object.assign(events, stateConfig.events);
  }

  if (stateConfig.on) {
    const handled = new Set(Object.keys(stateConfig.on));
    const result: Record<string, StandardSchemaV1> = {};
    for (const key of handled) {
      if (events[key]) {
        result[key] = events[key];
      }
    }
    return result;
  }

  return {};
}

/**
 * Find the event schema for a given event type.
 */
export function findEventSchema(
  config: MachineConfig,
  value: string,
  eventType: string
): StandardSchemaV1 | undefined {
  const stateConfig = resolveStateConfig(config, value);
  if (stateConfig.events?.[eventType]) {
    return stateConfig.events[eventType];
  }
  const events = config.schemas?.events as Record<string, StandardSchemaV1> | undefined;
  return events?.[eventType];
}

export function findEmittedSchema(
  config: MachineConfig,
  eventType: string
): StandardSchemaV1 | undefined {
  const emitted = config.schemas?.emitted as
    | Record<string, StandardSchemaV1>
    | undefined;

  return emitted?.[eventType];
}

export function formatSchemaIssues(
  issues: ReadonlyArray<{ message: string }>
): string {
  return issues.map((issue) => issue.message).join(', ');
}

export function isDoneInvokeEventType(
  stateValue: string,
  eventType: string
): boolean {
  return eventType === `xstate.done.invoke.${stateValue}`;
}

export function isErrorInvokeEventType(
  stateValue: string,
  eventType: string
): boolean {
  return eventType === `xstate.error.invoke.${stateValue}`;
}

export function isAlwaysEventType(
  stateValue: string,
  eventType: string
): boolean {
  return eventType === `xstate.always.${stateValue}`;
}

export function isReservedInternalEventType(eventType: string): boolean {
  return (
    eventType === 'xstate.init'
    || eventType.startsWith('xstate.done.invoke.')
    || eventType.startsWith('xstate.error.invoke.')
    || eventType.startsWith('xstate.always.')
  );
}

export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

export function appendMessages(
  messages: readonly AgentMessage[],
  ...nextMessages: AgentMessage[]
): AgentMessage[] {
  return messages.concat(nextMessages);
}

export function userMessage(content: string, extras: Record<string, unknown> = {}): AgentMessage {
  return { role: 'user', content, ...extras };
}

export function assistantMessage(content: string, extras: Record<string, unknown> = {}): AgentMessage {
  return { role: 'assistant', content, ...extras };
}

export function systemMessage(content: string, extras: Record<string, unknown> = {}): AgentMessage {
  return { role: 'system', content, ...extras };
}
