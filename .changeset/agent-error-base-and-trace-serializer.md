---
"@statelyai/agent": minor
---

**Unified error base class + JSON-safe trace events.**

- New exported `AgentError` base class: every error the package throws now extends it and carries a stable kebab-case `code` (`agent-idle`, `illegal-resume-event`, `snapshot-version-mismatch`, `decision-exhausted`, `lint-failed`, `event-log-conflict`, `non-serializable-event`, `replay-machine-mismatch`, `replay-divergence`), so hosts can branch on failures without `instanceof`.
- **Breaking (alpha)** renames for prefix consistency, no aliases: `IllegalResumeEventError` → `AgentIllegalResumeEventError`, `SnapshotVersionMismatchError` → `AgentSnapshotVersionMismatchError`, `DecisionExhaustedError` → `AgentDecisionExhaustedError`, `ReplayMachineMismatchError` → `AgentReplayMachineMismatchError`, `ReplayDivergenceError` → `AgentReplayDivergenceError`. `AgentLintError.diagnostics` is now `readonly`.
- New `serializeTraceEvent(event, { includeRaw? })`: projects an `AgentTraceEvent` into a guaranteed `JSON.stringify`-safe `JsonSerializableTraceEvent` for JSONL traces. Snapshots go through the same JSON round-trip as `persistSnapshot`; `request.end`'s raw SDK object is dropped unless `includeRaw`; functions, `undefined`, symbols, and cyclic back-references are dropped; `Error`s serialize as `{ name, message, stack?, code? }` instead of `{}`. Never throws.
- `RunAgentErrorCause` is now exported (it was already reachable through `result.cause`).
