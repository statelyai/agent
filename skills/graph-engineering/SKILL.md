---
name: graph-engineering
description: Route an agent-reliability request to the right @statelyai/agent skill and keep the four steps in order — make it a state machine, add traces, add evals, self-improve. Use when asked to "make my agent reliable", "graph engineering", "turn my agent into a state machine and improve it", "where do I start with this agent", or any request that spans more than one of those steps.
---

# Graph engineering

Four steps, in order. Each one needs the one before it.

| Step | Skill | Done when |
| --- | --- | --- |
| 1. Make it a state machine | `loop-to-machine` (existing code) or `generate-machine` (from scratch) | Rules are guards and the sentinel is unreachable (`canReach`). From existing code: the parity report has no unreviewed regressions. From scratch: every `verifyAgentConfig` gate passes |
| 2. Add traces | `add-traces` | Every run leaves a stamped log thread that replays to its final state |
| 3. Add evals | `add-evals` | Evals per state at the cheapest level, an objective, baseline numbers per split |
| 4. Self-improve | `improve-machine` | A pull request with one policy change and its held-out scorecard, or a report that none helped |

## Find where the project is

Check in this order and start at the first step that is not done:

1. Does the code path production actually runs go through a machine (`setupAgent`, `createMachine`, an `AgentWorkflowConfig`)? Follow the route or entry point to the model call; a machine that nothing calls does not count. If the path is a loop or ad-hoc code, step 1.
2. Do runs persist to an event log store with a declared machine `version` and a `metadata` stamp? If not, step 2.
3. Is there an objective over ground truth, and evals that name the states they cover? If not, step 3.
4. Otherwise, step 4.

Tell the user which step you are starting at and why, in one line, then load that skill.

## Across all steps

- **The environment is people's code.** Rules, guards, invariants, and the sentinel change only by human review. No step rewrites them on its own.
- **Ground truth scores everything.** Outcomes and effects in the world, labeled by people. A model never grades its own runs.
- **Ask for labels and rules; decide the mechanics.** Expected outcomes, thresholds, the objective, and the train/held-out split are the user's. File layout, test names, and helper code are yours.
- **Hand back between steps.** Finish one step's hand-back before starting the next, unless the user asked for several in one go.
