import type { AgentMachine, AgentState } from './types.js';
import {
  enterCompoundStates,
  resolveInitial,
  validateSchema,
} from './utils.js';

/**
 * Create the initial serializable state for a machine + input.
 * Validates input, initializes context, resolves the initial transition.
 */
export async function createInitialState(
  machine: AgentMachine,
  input: unknown
): Promise<AgentState> {
  // Validate input if schema provided
  let validatedInput = input;
  if (machine.inputSchema) {
    validatedInput = await validateSchema(machine.inputSchema, input);
  }

  // Initialize context
  const context = machine.context(validatedInput);

  // Resolve initial transition
  const init = resolveInitial(machine.initial, {
    context,
    parentParams: {},
  });

  if (!init.target) {
    throw new Error('Initial transition must specify a target state');
  }

  let state: AgentState = {
    value: init.target,
    params: {},
    context: init.context ? { ...context, ...init.context } : context,
    status: 'running',
  };

  if (init.params) {
    state.params = { [init.target]: init.params };
  }

  // Enter compound states if needed
  state = enterCompoundStates(machine, state);

  return state;
}
