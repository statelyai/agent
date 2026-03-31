import type { AgentMachine, AgentSnapshot, AgentState } from './types.js';
import { step } from './step.js';

/**
 * Yields a snapshot after each transition until completion, waiting, or error.
 */
export async function* stream(
  machine: AgentMachine,
  state: AgentState
): AsyncGenerator<AgentSnapshot> {
  let current = state;

  // Yield initial snapshot
  yield toSnapshot(current);

  while (current.status === 'running') {
    current = await step(machine, current);
    yield toSnapshot(current);
  }
}

function toSnapshot(state: AgentState): AgentSnapshot {
  return {
    value: state.value,
    context: state.context,
    status: state.status,
    params: state.params,
  };
}
