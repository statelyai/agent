/**
 * `@statelyai/agent/testing` — deterministic testing and evaluation of agent
 * machines: lint and reachability checks, scripted playthroughs with no
 * model, trajectory matching, seam runs, crash recovery, and parity with
 * the code a machine replaces. Trace analytics live in
 * `@statelyai/agent/evals`.
 *
 * Nothing here is needed to author or run an agent.
 * @module
 */
export {
  AgentLintError,
  AgentUnknownStateError,
  assertAgentMachine,
  canReach,
  explorePaths,
  lintAgentMachine,
  simulateAgent,
  textOutput,
} from "../verify.js";
export type {
  AgentLintDiagnostic,
  AgentLintSeverity,
  AgentPathReport,
  AgentPathTerminal,
  AssertAgentMachineOptions,
  CanReachOrdering,
  CanReachResult,
  CanReachTarget,
  ExploreSnapshot,
  ExploreStep,
  ExplorePathsOptions,
  LintAgentMachineOptions,
  SimulateAgentOptions,
  SimulateAgentResult,
  SimulationScript,
  SimulationTrailEntry,
} from "../verify.js";
export { checkCrashRecovery } from "../crash-recovery.js";
export type {
  CheckCrashRecoveryOptions,
  CrashEffect,
  CrashPoint,
  CrashRecoveryFailure,
  CrashRecoveryProblem,
  CrashRecoveryReport,
} from "../crash-recovery.js";
export { matchesTrajectory } from "../trajectory.js";
export type {
  MatchTrajectoryOptions,
  TrajectoryEvent,
  TrajectoryEventEnvelope,
  TrajectoryItem,
  TrajectoryMatch,
  TrajectoryMiss,
} from "../trajectory.js";
export { runSeam } from "../seam.js";
export type {
  RunSeamOptions,
  RunSeamResult,
  SeamCall,
  SeamRef,
  SeamScriptEntry,
  SeamSlice,
  SeamTurn,
} from "../seam.js";
export { compareRuns } from "../compare-runs.js";
export type {
  CompareRunsOptions,
  ParityLabel,
  ParityReport,
  ParityResult,
  ParityRun,
} from "../compare-runs.js";
export {
  compareRecordings,
  createRecorder,
  recordAiSdk,
  RecordingDivergenceError,
} from "../equivalence.js";
export type {
  AiSdkSeam,
  CompareRecordingsOptions,
  CreateRecorderOptions,
  EffectDivergence,
  EffectDivergenceReason,
  EquivalenceReport,
  ModelAnswer,
  ModelCallMatch,
  NormalizeEffect,
  RecordableDecisionModel,
  RecordableLanguageModel,
  RecordableModel,
  RecordedEffect,
  RecordCallOptions,
  RecordClientOptions,
  RecordedCall,
  RecordedError,
  RecordedModelCall,
  RecordedOutput,
  RecordedToolCall,
  Recorder,
  Recording,
} from "../equivalence.js";
export { checkConformance } from "../conformance.js";
export type {
  CheckConformanceOptions,
  ConformanceActor,
  ConformanceActorArgs,
  ConformanceDeviation,
  ConformanceDeviationReason,
  ConformanceEvent,
  ConformanceEventArgs,
  ConformanceObservation,
  ConformanceOutput,
  ConformanceReport,
} from "../conformance.js";
export { checkParity } from "../check-parity.js";
export type {
  CheckParityBaseOptions,
  CheckParityOptions,
  CheckParityOutcome,
  CheckParityReport,
  CheckParityRow,
  CheckParityScenario,
  CheckParitySetup,
} from "../check-parity.js";
