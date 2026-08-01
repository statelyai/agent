---
"@statelyai/agent": minor
---

**Ship the `generate-machine` agent skill in the package.**

`skills/generate-machine/SKILL.md` teaches a coding agent the full machine-authoring loop: read the shipped `agent-workflow.json` schema, author an `AgentWorkflowConfig`, validate with Ajv, lower via `setupAgent.fromConfig`, `assertAgentMachine`, dry-run with `simulateAgent`, and repair on errors. Installed users can point their agent at `node_modules/@statelyai/agent/skills/generate-machine/` instead of copying it from the repo. See docs/generate-machines.md.
