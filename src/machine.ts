import type { AgentMachine, MachineConfig } from './types.js';

/**
 * Create an agent machine definition.
 * The machine is a pure configuration object — no runtime state.
 */
export function createAgentMachine(config: MachineConfig): AgentMachine {
  return config;
}
