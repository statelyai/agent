// Core
export { createAgentMachine } from './machine.js';

// AI primitives
export { decide } from './decide.js';
export { classify } from './classify.js';

// Adapter
export { createAdapter } from './adapter.js';
export { createMemoryRunStore } from './runtime/memory-store.js';
export { restoreSession, startSession } from './runtime/session.js';

// Types
export type {
  AgentAdapter,
  AgentMachine,
  AgentRun,
  AgentSnapshot,
  AgentState,
  ClassifyConfig,
  DecideConfig,
  DecideResultFor,
  EmittedPart,
  EmittedUnion,
  EventPayload,
  EventUnion,
  ExecuteResult,
  InferOutput,
  InvokeEnqueue,
  JournalEvent,
  JournalEventRecord,
  MachineConfig,
  PersistedSnapshot,
  RestoreSessionOptions,
  RunStore,
  SessionOptions,
  StandardSchemaV1,
  StateConfig,
  Trace,
  TransitionEvent,
  TransitionResult,
} from './types.js';
