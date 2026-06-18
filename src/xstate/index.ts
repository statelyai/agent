import type { XStateLikeMachine } from '../graph/index.js';

export type XStateMachineConfig = XStateLikeMachine['config'];

export function toXStateVisualization(machine: XStateLikeMachine): XStateMachineConfig {
  return machine.config;
}

export const toXStateMachine = toXStateVisualization;
