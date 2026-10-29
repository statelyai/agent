/**
 * `@statelyai/agent/testing` — deterministic testing and evaluation of agent
 * machines: lint and reachability checks, scripted playthroughs with no
 * model, trajectory matching, and seam runs for evals.
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
} from "../verify.js";
export type {
  AgentLintDiagnostic,
  AgentLintSeverity,
  AgentPathReport,
  AgentPathTerminal,
  AssertAgentMachineOptions,
  CanReachResult,
  CanReachTarget,
  ExploreSnapshot,
  ExplorePathsOptions,
  LintAgentMachineOptions,
  SimulateAgentOptions,
  SimulateAgentResult,
  SimulationScript,
  SimulationTrailEntry,
} from "../verify.js";
export { matchesTrajectory } from "../trajectory.js";
export type {
  MatchTrajectoryOptions,
  TrajectoryEvent,
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
export { foldTraces } from "../fold-traces.js";
export { traceCoverage } from "../trace-coverage.js";
export type {
  CoverageReport,
  HandlerCoverage,
  HandlerRef,
  StateCoverage,
  TraceCoverageOptions,
} from "../trace-coverage.js";
export { firstDivergence } from "../first-divergence.js";
export type { Divergence, FirstDivergenceOptions, TraceStep } from "../first-divergence.js";
export type { FoldTracesOptions, StateStats } from "../fold-traces.js";
export { getDecisionRequests } from "../decision-requests.js";
export type { GetDecisionRequestsOptions, TracedDecisionRequest } from "../decision-requests.js";
export { repeatRuns, summarizeRepeats } from "../repeat-runs.js";
export type {
  RepeatGroup,
  RepeatReport,
  RepeatResult,
  RepeatRun,
  RepeatRunsOptions,
} from "../repeat-runs.js";
export { judgeAgreement } from "../judge-agreement.js";
export type {
  AgreementReport,
  AgreementRow,
  AgreementSummary,
  JudgeAgreementOptions,
} from "../judge-agreement.js";
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
  RecordingDivergenceError,
  sameModelCallShape,
} from "../equivalence.js";
export type {
  CompareRecordingsOptions,
  CreateRecorderOptions,
  EffectDivergence,
  EffectDivergenceReason,
  EquivalenceReport,
  ModelCallMatch,
  RecordableLanguageModel,
  RecordedEffect,
  RecordedError,
  RecordedModelCall,
  RecordedOutput,
  RecordedToolCall,
  Recorder,
  Recording,
} from "../equivalence.js";
