---
"@statelyai/agent": minor
---

New keyless verification surface — lint, simulate, and explore an agent machine with no API key and no model calls. A coding agent that generates a machine can now close the loop and self-verify it.

- **`lintAgentMachine(machine, options?)`** — static structural checks over a built machine (TS-authored or `setupAgent.fromConfig`-compiled), returning `AgentLintDiagnostic[]` (`{ code, severity, path, message }`). Checks: `unreachable-state`, `decide-without-events`, `unserializable-context`, `direct-object-src`, `final-without-output`, `missing-final`. Reachability is conservative — dynamic (function) transitions over-approximate, so it never false-flags a live state.
- **`simulateAgent(machine, { input, script, maxSteps? })`** — a deterministic, model-free playthrough on the pure step path. The `script` supplies responses by invoke `src` (FIFO queues) for `decisions`, `text`, and `userInput`. Returns `{ status: 'done' | 'idle' | 'exhausted', snapshot, trail }`, and throws a descriptive error (naming the pending request) when the script runs dry.
- **`explorePaths(machine, { input, maxDepth?, maxPaths?, textOutputs? })`** — enumerates decision and idle-state external-event branches, reporting reached states, per-path terminals, and a `prunedByGuard` count (guard-rejected candidates). Bounded by `maxDepth` (default 8) and `maxPaths` (default 200).
- **`canReach(machine, statePath, opts)`** — thin wrapper over `explorePaths` returning `{ canReach, witness }` (the event sequence that reaches the state).
- **`statelyai-agent lint <workflow.json>` CLI** — a thin binary that structure-only-lints a machine authored as data (`AgentWorkflowConfig` JSON), exiting `1` on any error-severity finding. The library bundles no JSON Schema engine, so the CLI compiles with a permissive pass-through compiler; use the API with a real compiler for full schema-aware linting.

New exported types: `AgentLintDiagnostic`, `AgentLintSeverity`, `LintAgentMachineOptions`, `SimulationScript`, `SimulateAgentOptions`, `SimulateAgentResult`, `SimulationTrailEntry`, `ExplorePathsOptions`, `AgentPathReport`, `AgentPathTerminal`, `CanReachResult`.
