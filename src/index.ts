export { AgentError } from "./errors.js";
export { appendMessages, messagesSchema } from "./messages.js";
export { createAgentSchemas, setupAgent } from "./setup-agent.js";
export {
  AgentDecisionExhaustedError,
  PLAN_DONE_EVENT_TYPE,
  renderDecisionAttempts,
  resolveDecision,
} from "./decision.js";
export { getAcceptedEvents, parseAgentEvent } from "./events.js";
export {
  bindRequestExecutor,
  buildEnvelopeSchema,
  createTextLogic,
  getAgentOutputMode,
  parseModelRef,
  parseOutput,
  parseStructuredEnvelope,
} from "./text-logic.js";
export { executeAgentRequest } from "./steps.js";
export type { AgentPlanRequest, AgentRequest, AgentStepRequest } from "./steps.js";
export {
  AGENT_TRACE_SCHEMA_VERSION,
  AgentIdleError,
  AgentIllegalResumeEventError,
  inspectTransitions,
  runAgent,
  createAgentActor,
  generateResult,
  AgentSnapshotVersionMismatchError,
  serializeTraceEvent,
  traceTransitions,
} from "./run-agent.js";
export type { AgentActorSession } from "./run-agent.js";
export { createAgentRun } from "./agent-run.js";
export type { AgentRun } from "./agent-run.js";
export { provideExecutors } from "./provide-executors.js";
export type { ProvideExecutorsOptions } from "./provide-executors.js";
export {
  AgentLintError,
  assertAgentMachine,
  canReach,
  explorePaths,
  lintAgentMachine,
  simulateAgent,
} from "./verify.js";
export {
  getAgentMessages,
  getJsonSchema,
  getJsonSchemaSync,
  getMachineStructuralHash,
  getStateMeta,
  isStandardSchema,
  persistSnapshot,
} from "./utils.js";
export { assistantMessage, systemMessage, toolMessage, userMessage } from "./utils.js";
export {
  AGENT_EVENT_SCHEMA_VERSION,
  AgentEventLogConflictError,
  NonSerializableAgentEventError,
  assertAgentLogEntry,
  assertEventLogStoreConformance,
  assertJsonSerializable,
  createInMemoryEventLogStore,
} from "./event-log-store.js";
export type {
  AgentEventLogStore,
  AgentLogEntry,
  AgentLogVerification,
  JsonValue,
} from "./event-log-store.js";
export {
  AGENT_INIT_EVENT_TYPE,
  AgentReplayDivergenceError,
  AgentReplayMachineMismatchError,
  createReplayEntry,
  diffEventLogs,
  getAgentEffects,
  initEntry,
  replay,
  verifyReplay,
} from "./effects.js";
export type {
  AgentEffectDiff,
  AgentEventLogDiff,
  AgentEffect,
  AgentLogPatchOperation,
  CreateReplayEntryOptions,
  GetAgentEffectsOptions,
  ReplayOptions,
  ReplayResult,
} from "./effects.js";

export type {
  AgentDecisionInput,
  AgentDecisionRequest,
  AgentDecisionExecutor,
  AgentPlanInput,
  AgentPlanOutput,
  DecisionLogicConfig,
  ResolveDecisionOptions,
} from "./decision.js";
export type {
  AgentModelRef,
  AgentOutputMode,
  StructuredOutputEnvelope,
  AgentTextRequest,
  AiSdkShapedStreamResult,
  AiSdkShapedTextResult,
  AgentRequestExecutor,
  AgentRequestExecutorInfo,
  AgentRequestExecutorResult,
  AgentRequestExecutors,
  AgentUsage,
  AgentCallUsage,
  AgentUserInput,
  TextLogic,
  TextLogicConfig,
  TextLogicExecuteArgs,
  TextLogicExecutor,
} from "./text-logic.js";
export type {
  AgentRequestOptions,
  AgentEventDescriptor,
  AgentEventToolNameResolver,
  AgentRequestSource,
} from "./events.js";
export type {
  AgentMessageInfo,
  AgentRunMeta,
  AgentStateRequest,
  AgentTraceEvent,
  AgentUserInputExecutor,
  InspectedActorRef,
  JsonSerializableTraceEvent,
  PendingUserInput,
  RunAgentOptions,
  GenerateResult,
  RunAgentResult,
  RunAgentErrorCause,
} from "./run-agent.js";
export type {
  AgentLintDiagnostic,
  AgentLintSeverity,
  AgentPathReport,
  AgentPathTerminal,
  AssertAgentMachineOptions,
  CanReachResult,
  ExplorePathsOptions,
  LintAgentMachineOptions,
  SimulateAgentOptions,
  SimulateAgentResult,
  SimulationScript,
  SimulationTrailEntry,
} from "./verify.js";
export type {
  AgentWorkflowActionConfig,
  AgentWorkflowActorConfig,
  AgentWorkflowConfig,
  AgentWorkflowInvokeConfig,
  AgentWorkflowStateConfig,
  AgentWorkflowRequestConfig,
  AgentWorkflowTransitionConfig,
  FromConfigOptions,
  FromConfigResult,
  SchemaCompiler,
} from "./workflow-config.js";
export type { AgentSchemaPack } from "./setup-agent.js";
// `PlanLogic` is re-exported not for direct use (its constructor is `@internal`)
// but because it appears in the inferred type of a machine using `agent.plan`;
// without it, consumers' declaration emit fails with TS4023 "cannot be named".
export type { DecisionAttempt, PlanLogic } from "./decision.js";

export type {
  AgentMessage,
  AgentSnapshotStore,
  AgentTool,
  AgentToolChoice,
  AgentToolDescriptor,
  AgentToolExecute,
  AgentTools,
  AllowedEvents,
  AssistantMessage,
  ChosenEvent,
  FilePart,
  ImagePart,
  InferOutput,
  StandardSchemaV1,
  SystemMessage,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from "./types.js";
