/**
 * `@statelyai/agent/testing` — deterministic testing and evaluation of agent
 * machines: lint and reachability checks, scripted playthroughs with no
 * model, scripted executors keyed by request name, trajectory matching, and
 * seam runs for evals.
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
  SeamSlice,
  SeamTurn,
} from "../seam.js";
export { createScriptedExecutors } from "../scripted-executors.js";
export type {
  ScriptedByName,
  ScriptedDecisionEntry,
  ScriptedDecisionValue,
  ScriptedExecutors,
  ScriptedExecutorsScript,
  ScriptedTextEntry,
} from "../scripted-executors.js";
