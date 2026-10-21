---
"@statelyai/agent": minor
---

**`recordLog(actor)` records a plain actor run.** From `@statelyai/agent/log`: attach it to a `createActor` actor before `start()`, and `log.entries` is an event log of the run (init entry, then every event the root machine processed, invoke outputs inline) that `replay` folds with no actor executed. An actor created from a `snapshot` starts its log from that snapshot.
