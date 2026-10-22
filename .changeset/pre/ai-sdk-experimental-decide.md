---
"@statelyai/agent": patch
"@statelyai/agent-demo": patch
---

Move judgments to the AI SDK's non-deprecated decision API (`ai` 7.0.133, `@ai-sdk/typesafe-ai` 3.0.16):

- `experimental_evaluate` → `experimental_decide`
- `Experimental_EvaluationModel` / `Experimental_EvaluationQuestion` → `Experimental_DecisionModel` / `Experimental_DecisionQuestion`
- `typeSafeAi.evaluationModel("jev-latest")` → `typeSafeAi.decisionModel("jev-latest")`
- Scripted judges implement `doDecide` instead of `doEvaluate`. The SDK now hands a model its `state` as parts, so a plain value arrives as `[{ type: "json", value }]`.
