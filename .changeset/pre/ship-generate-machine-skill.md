---
"@statelyai/agent": minor
---

**The `generate-machine` agent skill now ships in the package.** Point a coding agent at `node_modules/@statelyai/agent/skills/generate-machine/` instead of copying it out of the repo.

`skills/generate-machine/SKILL.md` teaches the full machine-authoring loop: read the shipped `agent-workflow.json` schema, author an `AgentWorkflowConfig`, validate it with Ajv, lower it via `setupAgent.fromConfig`, check with `assertAgentMachine` / `lintAgentMachine`, dry-run with `simulateAgent`, and repair on errors. See `docs/generate-machines.md`.
