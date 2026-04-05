// Core
export { createAgentMachine } from './machine.js';

// AI primitives
export { decide } from './decide.js';
export { classify } from './classify.js';

// Adapter
export { createAdapter } from './adapter.js';

// Types
export type {
  AgentAdapter,
  AgentMachine,
  AgentSnapshot,
  AgentState,
  ClassifyConfig,
  DecideConfig,
  DecideResultFor,
  EventPayload,
  EventUnion,
  ExecuteResult,
  InferOutput,
  MachineConfig,
  StandardSchemaV1,
  StateConfig,
  Trace,
  TransitionEvent,
  TransitionResult,
} from './types.js';
