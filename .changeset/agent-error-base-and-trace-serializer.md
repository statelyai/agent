---
"@statelyai/agent": minor
---

**One error base class with stable codes, and JSON-safe trace events.**

```ts
try {
  await generateResult(machine, { input, executors });
} catch (error) {
  if (error instanceof AgentError && error.code === "agent-idle") {
    // branch on the code — no instanceof ladder, survives bundle boundaries
  }
}
```

- New exported `AgentError` base class: every error the package throws extends it and carries a stable kebab-case `code` — `agent-idle`, `illegal-resume-event`, `snapshot-version-mismatch`, `decision-exhausted`, `lint-failed`, `event-log-conflict`, `non-serializable-event`, `replay-machine-mismatch`, `replay-divergence`, `max-model-calls-exceeded`, `scripted-executors-exhausted`, `seam-script-exhausted`.
- **Breaking (alpha)** renames for prefix consistency, no aliases: `IllegalResumeEventError` → `AgentIllegalResumeEventError`, `SnapshotVersionMismatchError` → `AgentSnapshotVersionMismatchError`, `DecisionExhaustedError` → `AgentDecisionExhaustedError`, `ReplayMachineMismatchError` → `AgentReplayMachineMismatchError`, `ReplayDivergenceError` → `AgentReplayDivergenceError`. `AgentLintError.diagnostics` is now `readonly`.
- New `serializeTraceEvent(event, { includeRaw? })` projects an `AgentTraceEvent` into a `JSON.stringify`-safe `JsonSerializableTraceEvent` for JSONL traces. Snapshots take the same JSON round-trip as `persistSnapshot`; `request.end`'s raw SDK object is dropped unless `includeRaw`; functions, `undefined`, symbols and cyclic back-references are dropped; `Error`s serialize as `{ name, message, stack?, code? }` instead of `{}`. Never throws.
- `RunAgentErrorCause` is now exported (it was already reachable through `result.cause`).
