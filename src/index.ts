// Core
export { createAgentMachine } from './machine.js';

// AI primitives
export { decide } from './decide.js';
export { classify } from './classify.js';

// Adapter
export { createAdapter } from './adapter.js';
export { createMemoryRunStore } from './runtime/memory-store.js';

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
  JournalEvent,
  MachineConfig,
  PersistedSnapshot,
  RunStore,
  StandardSchemaV1,
  StateConfig,
  Trace,
  TransitionEvent,
  TransitionResult,
} from './types.js';
