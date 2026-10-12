---
"@statelyai/agent": patch
---

**Two more examples.** `examples/rank-candidates` ranks a list against a brief: Jev scores each candidate and judges near-duplicate pairs, while code applies the threshold, sort, per-bucket quota and top-k cut-off, with a reason for every cut. `examples/answer-reuse` judges the help article a search already found before spending an agent call, investigates at most once, and settles idle for a person when the answer still does not pass.
