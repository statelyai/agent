/**
 * `@statelyai/agent/evals` — analytics over recorded runs: per-state stats,
 * trace coverage, first divergence, repeated-run reliability, judge agreement,
 * and proposals for caps and approval rules from traces.
 *
 * Nothing here is needed to author, run, or test an agent.
 * @module
 */
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
export { proposeApprovalRules, proposeCaps } from "../propose-from-traces.js";
export type {
  ApprovalRuleProposal,
  ApprovalVerdict,
  CapProposal,
  CapSpec,
  ProposeApprovalRulesOptions,
  ProposeCapsOptions,
} from "../propose-from-traces.js";
export { repeatRuns } from "../repeat-runs.js";
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
