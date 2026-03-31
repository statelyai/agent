import type { AgentMachine, AgentRunResult, AgentState } from './types.js';
import { step } from './step.js';
import { getAvailableEvents, resolveStateConfig } from './utils.js';

/**
 * Run the machine until completion, waiting, or error.
 * Loops `step()` while status is 'running'.
 */
export async function run(
  machine: AgentMachine,
  state: AgentState
): Promise<AgentRunResult> {
  let current = state;

  while (current.status === 'running') {
    current = await step(machine, current);
  }

  switch (current.status) {
    case 'done':
      return {
        status: 'done',
        state: current,
        output: current.output,
        context: current.context,
      };

    case 'waiting':
      return {
        status: 'waiting',
        state: current,
        value: current.value,
        events: getAvailableEvents(machine, current.value),
        context: current.context,
      };

    case 'error':
      return {
        status: 'error',
        state: current,
        error: current.error,
      };

    default:
      return {
        status: 'error',
        state: current,
        error: `Unexpected status: ${current.status}`,
      };
  }
}
