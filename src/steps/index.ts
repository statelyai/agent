/**
 * `@statelyai/agent/steps` — the low-level primitives a host loop drives an
 * agent machine with directly, instead of handing the whole run to `runAgent`.
 *
 * The core is the effect/replay pair from the append-only-log core:
 * {@link getAgentEffects} lowers a transition's frontier into an ordered
 * {@link AgentEffect} list the host executes and journals, and {@link replay}
 * folds a journal back to `{ snapshot, effects }` for crash recovery / resume /
 * time travel. {@link initEntry} makes the reserved first journal entry. Around
 * them sit the per-effect resolvers a host calls at the frontier —
 * {@link executeAgentRequest} for a `text` effect and {@link resolveDecision}
 * for a `decision`/`plan` step — plus the decision control-flow helpers
 * (`renderDecisionAttempts`, `PLAN_DONE_EVENT_TYPE`) hand-rolled loops rely on.
 * @module
 */
export {
  AGENT_INIT_EVENT_TYPE,
  ReplayDivergenceError,
  ReplayMachineMismatchError,
  createReplayEntry,
  diffEventLogs,
  getAgentEffects,
  initEntry,
  replay,
  verifyReplay,
} from "../effects.js";
export type {
  AgentEffectDiff,
  AgentEventLogDiff,
  AgentEffect,
  AgentLogPatchOperation,
  CreateReplayEntryOptions,
  GetAgentEffectsOptions,
  ReplayOptions,
  ReplayResult,
} from "../effects.js";

export {
  AGENT_EVENT_SCHEMA_VERSION,
  NonSerializableAgentEventError,
  assertAgentLogEntry,
  assertJsonSerializable,
} from "../event-log-store.js";
export type { AgentLogEntry, AgentLogVerification, JsonValue } from "../event-log-store.js";

export { executeAgentRequest } from "../steps.js";
export type { AgentPlanRequest, AgentRequest, AgentStepRequest } from "../steps.js";

export { PLAN_DONE_EVENT_TYPE, renderDecisionAttempts, resolveDecision } from "../decision.js";
export type {
  AgentDecisionExecutor,
  AgentDecisionRequest,
  DecisionAttempt,
  DecisionLogicConfig,
  ResolveDecisionOptions,
} from "../decision.js";

export type { AgentTextRequest } from "../text-logic.js";
export type { AgentEventDescriptor, AgentRequestSource } from "../events.js";
