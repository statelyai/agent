/**
 * `@statelyai/agent/log` — the event log: an append-only journal of the
 * external inputs a machine consumed, the pure `replay` fold that rebuilds a
 * snapshot from it, and the store contract a host implements to persist it.
 *
 * `createAgentRuntime(machine, { store, threadId })` drives all of this for you. Import from
 * here when you build log entries by hand, replay a log outside a run, fork
 * a thread, or test a store implementation.
 * @module
 */
export {
  AgentEventLogError,
  AgentMachineVersionMismatchError,
  AgentReplayDivergenceError,
  NonSerializableAgentEventError,
  assertAgentLogEntry,
  assertJsonSerializable,
  createReplayEntry,
  forkEventLog,
  getDecisionAttempts,
  getLogExecutionId,
  getUsageFromEvents,
  initEntry,
  recordLog,
  replay,
} from "../event-log.js";
export type {
  AgentInitEvent,
  AgentLogEntry,
  AgentLogInit,
  AgentLogVerification,
  AgentPersistedSnapshot,
  CreateReplayEntryOptions,
  JsonValue,
  LogRecorder,
  ReplayOptions,
  ReplayResult,
} from "../event-log.js";
export { AgentEventLogConflictError, createInMemoryEventLogStore } from "../event-log-store.js";
export type { AgentEventLogStore } from "../event-log-store.js";
export { assertEventLogStoreConformance } from "../event-log-store-conformance.js";
export type { EventLogStoreConformanceHarness } from "../event-log-store-conformance.js";
