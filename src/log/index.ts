/**
 * `@statelyai/agent/log` — the event log: an append-only journal of the
 * external inputs a machine consumed, the pure `replay` fold that rebuilds a
 * snapshot from it, and the store contract a host implements to persist it.
 *
 * `runAgent({ store, threadId })` drives all of this for you. Import from
 * here when you build log entries by hand, replay a log outside a run, fork
 * a thread, or test a store implementation.
 * @module
 */
export {
  AGENT_EVENT_SCHEMA_VERSION,
  AGENT_INIT_EVENT_TYPE,
  AgentEventLogError,
  AgentMachineVersionMismatchError,
  AgentReplayDivergenceError,
  NonSerializableAgentEventError,
  agentCallOccurrence,
  assertAgentLogEntry,
  assertJsonSerializable,
  createReplayEntry,
  forkEventLog,
  getLogExecutionId,
  getSnapshotStateHash,
  getUsageFromEvents,
  initEntry,
  rebindActorSession,
  replay,
  validateReplayEntries,
} from "../event-log.js";
export type {
  AgentInitEvent,
  AgentLogEntry,
  AgentLogInit,
  AgentLogVerification,
  AgentPersistedSnapshot,
  CreateReplayEntryOptions,
  JsonValue,
  ReplayOptions,
  ReplayResult,
} from "../event-log.js";
export { AgentEventLogConflictError, createInMemoryEventLogStore } from "../event-log-store.js";
export type { AgentEventLogStore } from "../event-log-store.js";
export { assertEventLogStoreConformance } from "../event-log-store-conformance.js";
export type { EventLogStoreConformanceHarness } from "../event-log-store-conformance.js";
