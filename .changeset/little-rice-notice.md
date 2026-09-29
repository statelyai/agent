---
"@statelyai/agent": patch
---

Restore agent runs without sending a synthetic machine event, so wildcard
transitions are not triggered during restoration. Preserve timer deadlines and
stop in-flight child requests through XState's public runtime API. Pin the XState
peer dependency to `6.0.0-alpha.57` while its experimental durable APIs evolve.
