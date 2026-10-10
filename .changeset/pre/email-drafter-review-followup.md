---
"@statelyai/agent-demo": patch
---

Email drafter comparison: a request that errors still counts as a model call; the summary token total stays `null` unless every run reported usage; `byCategory` is typed as partial for filtered runs; scripted mode reads an angle-bracketed address. Both drafters output a `clarifications` array: v1 collects the evaluator's questions, v2 collects the `openQuestions` its drafter raises while drafting around gaps, shown under the draft as open questions.
