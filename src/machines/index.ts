/**
 * Preset agent machines: thin factories over `setupAgent(...).createMachine(...)`.
 *
 * Every preset returns an ORDINARY, fully inspectable XState machine — same
 * states, same lint, same snapshots as a hand-written one. Executors are still
 * supplied separately by the host (`createAgentRuntime`/`provideExecutors`), and nothing
 * here names an SDK.
 *
 * See docs/machines-presets.md.
 */
export { createApprovalBatchMachine } from "./approval-batch.js";
export type {
  ApprovalBatchContext,
  ApprovalBatchEvent,
  ApprovalBatchInput,
  ApprovalBatchMachine,
  ApprovalBatchOutput,
  ApprovalCallInput,
  ApprovalCallResult,
  ApprovalDecision,
  ApproveAlwaysRule,
  CreateApprovalBatchMachineConfig,
  ProposedCall,
} from "./approval-batch.js";
