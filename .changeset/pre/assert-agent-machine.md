---
"@statelyai/agent": minor
---

**`assertAgentMachine(machine, options?)`**: one-line pass/fail wrapper over `lintAgentMachine` for tests and generation loops. Silent when clean; throws the new `AgentLintError` (findings on `.diagnostics`) on any error-severity finding. `warnings: true` fails warning-severity findings too, and `disable` forwards to lint. New exports: `assertAgentMachine`, `AgentLintError`, `AssertAgentMachineOptions`.
