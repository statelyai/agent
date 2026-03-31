// Core
export { createAgentMachine } from './machine.js';
export { createInitialState } from './state.js';
export { step } from './step.js';
export { run } from './run.js';
export { stream } from './stream.js';
export { sendEvent } from './event.js';

// AI primitives
export { decide } from './decide.js';
export { classify } from './classify.js';

// Adapter
export { createAdapter } from './adapter.js';

// Types
export type {
  AgentAdapter,
  AgentEvent,
  AgentMachine,
  AgentRunResult,
  AgentSnapshot,
  AgentState,
  ClassifyConfig,
  ClassifyResult,
  DecideConfig,
  DecideResult,
  MachineConfig,
  OnDoneArgs,
  OutputArgs,
  RunArgs,
  StandardSchemaV1,
  StateConfig,
  Trace,
  TransitionArgs,
  TransitionResult,
} from './types.js';
