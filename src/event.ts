import type { AgentEvent, AgentMachine, AgentState, StandardSchemaV1 } from './types.js';
import { applyTransition, resolveStateConfig } from './utils.js';

/**
 * Send a typed event to the current state.
 * Validates the event payload against declared schemas, then searches from
 * the current state up through ancestors for a matching handler.
 * Parent handlers preempt children.
 *
 * Returns a new AgentState (synchronous — no async work).
 */
export function sendEvent(
  machine: AgentMachine,
  state: AgentState,
  event: AgentEvent
): AgentState {
  // Validate event payload against declared schemas
  validateEventSync(machine, state.value, event);

  const parts = state.value.split('.');

  // Walk from outermost to innermost for preemption semantics:
  // parent `on` preempts children.
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('.');
    const config = resolveStateConfig(machine, path);

    if (config.on && config.on[event.type]) {
      const handler = config.on[event.type]!;
      const transition = handler({ context: state.context, event });

      if (transition.target) {
        return applyTransition(machine, state, transition, path);
      }

      // Self-transition: update context, keep same state/status
      return {
        ...state,
        context: transition.context
          ? { ...state.context, ...transition.context }
          : state.context,
      };
    }
  }

  throw new Error(
    `No handler for event '${event.type}' in state '${state.value}'`
  );
}

/**
 * Validate event payload against the schema declared in state-level or
 * root-level `events`. State events override root events.
 * Uses synchronous validation — throws on invalid payload.
 */
function validateEventSync(
  machine: AgentMachine,
  value: string,
  event: AgentEvent
): void {
  const schema = findEventSchema(machine, value, event.type);
  if (!schema) return; // no schema declared — skip validation

  const result = schema['~standard'].validate(event);

  // Handle sync result (most schema libs return sync for simple schemas)
  if (result && typeof result === 'object' && 'issues' in result && result.issues) {
    const messages = (result.issues as Array<{ message: string }>)
      .map((i) => i.message)
      .join(', ');
    throw new Error(
      `Invalid event '${event.type}': ${messages}`
    );
  }

  // If validate returns a Promise, we can't block on it synchronously.
  // For async schemas, users should validate before calling sendEvent.
  if (result instanceof Promise) {
    // Can't await in sync function — skip async validation.
    // This is a known limitation; createInitialState handles async validation.
    return;
  }
}

/**
 * Find the event schema for a given event type.
 * Walks from the current state up to root, with state-level schemas
 * overriding root-level schemas.
 */
function findEventSchema(
  machine: AgentMachine,
  value: string,
  eventType: string
): StandardSchemaV1 | undefined {
  // Check state-level events (innermost wins for schemas)
  const parts = value.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const path = parts.slice(0, i).join('.');
    const config = resolveStateConfig(machine, path);
    if (config.events?.[eventType]) {
      return config.events[eventType];
    }
  }

  // Fall back to root-level events
  return machine.events?.[eventType];
}
