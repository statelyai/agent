export { AgentError } from "./errors.js";
export type {
  ContextOf,
  EventOf,
  InputOf,
  MetaOf,
  OutputOf,
  RequestNamesOf,
  SnapshotOf,
  StateValueOf,
} from "./type-helpers.js";
export { AGENT_MESSAGES_EVENT_TYPE, appendMessages, messagesSchema } from "./messages.js";
export type { AgentMessagesEvent, AgentMessagesEventPayload } from "./messages.js";
export { createAgentSchemas, getAgentSchemas, setupAgent } from "./setup-agent.js";
export type {
  AgentSchemaPack,
  // Both appear in `setupAgent`'s inferred result type (its event schemas
  // always carry the reserved `'@agent.usage'` entry), so consumers' declaration
  // emit needs them nameable.
  AgentUsageEventPayload,
  WithAgentEvents,
  WithAgentUsageEvent,
} from "./setup-agent.js";
export {
  AgentDecisionExhaustedError,
  createDecisionLogic,
  renderDecisionAttempts,
  resolveDecision,
} from "./decision.js";
export type {
  AgentDecisionInput,
  AgentExecutorDecisionRequest,
  AgentDecisionRequest,
  AgentDecisionExecutor,
  DecisionAttempt,
  // Return type of `createDecisionLogic`, so declaration emit can name it.
  DecisionLogic,
  DecisionLogicConfig,
  ResolveDecisionOptions,
} from "./decision.js";
export { getAcceptedEvents, parseAgentEvent } from "./events.js";
export { eventFromInteraction, getInteraction } from "./interaction.js";
export type { AgentInteraction, AgentInteractionEvent } from "./interaction.js";
export type {
  AgentRequestOptions,
  // Named return type of `getAgentSchemas`, so declaration emit can name it.
  AgentSchemas,
  AgentEventDescriptor,
  AgentEventToolNameResolver,
  AgentRequestSource,
} from "./events.js";
export {
  bindRequestExecutor,
  buildEnvelopeSchema,
  createTextLogic,
  getAgentOutputMode,
  getCallUsage,
  parseModelRef,
  parseOutput,
  parseStructuredEnvelope,
} from "./text-logic.js";
export type {
  AgentModelRef,
  AgentOutputMode,
  StructuredOutputEnvelope,
  AgentExecutorTextRequest,
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
export { executeAgentRequest } from "./steps.js";
export type { AgentRequest, AgentStepRequest } from "./steps.js";
export { AGENT_USAGE_EVENT_TYPE } from "./usage.js";
export type { AgentUsageEvent } from "./usage.js";
export {
  AGENT_TRACE_SCHEMA_VERSION,
  AgentIllegalResumeEventError,
  AgentMaxModelCallsExceededError,
  inspectTransitions,
  isAgentIdle,
  runAgent,
  serializeTraceEvent,
  traceTransitions,
} from "./run-agent.js";
export { runAgentStream } from "./agent-run.js";
export type { AgentStreamEvent } from "./agent-run.js";
export { runAgentLoop } from "./run-loop.js";
export type { RunAgentLoopOptions } from "./run-loop.js";
export type {
  AgentInputFrom,
  AgentTransitionHandler,
  AgentTraceEvent,
  AgentUserInputExecutor,
  InspectedActorRef,
  JsonSerializableTraceEvent,
  PendingUserInput,
  RunAgentOptions,
  RunAgentResult,
  RunAgentErrorCause,
} from "./run-agent.js";
export { provideExecutors } from "./provide-executors.js";
export type { ProvideExecutorsOptions } from "./provide-executors.js";
export {
  AgentLintError,
  AgentUnknownStateError,
  assertAgentMachine,
  canReach,
  explorePaths,
  lintAgentMachine,
  simulateAgent,
} from "./verify.js";
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
export { matchesTrajectory } from "./trajectory.js";
export type {
  MatchTrajectoryOptions,
  TrajectoryEvent,
  TrajectoryItem,
  TrajectoryMatch,
  TrajectoryMiss,
} from "./trajectory.js";
export { runSeam } from "./seam.js";
export type {
  RunSeamOptions,
  RunSeamResult,
  SeamCall,
  SeamRef,
  SeamSlice,
  SeamTurn,
} from "./seam.js";
export { createScriptedExecutors } from "./scripted-executors.js";
export type {
  ScriptedDecisionEntry,
  ScriptedDecisionValue,
  ScriptedExecutors,
  ScriptedExecutorsScript,
  ScriptedTextEntry,
  ScriptedUserInputEntry,
} from "./scripted-executors.js";
export {
  assistantMessage,
  getJsonSchema,
  getJsonSchemaSync,
  getMessageText,
  getMachineStructuralHash,
  getStateMeta,
  isStandardSchema,
  systemMessage,
  toolMessage,
  userMessage,
} from "./utils.js";
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
export type {
  AgentMessage,
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
  InferInput,
  InferOutput,
  StandardSchemaV1,
  SystemMessage,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from "./types.js";
