---
"@statelyai/agent": patch
---

**Parallel invokes replay from the store.** A run whose parallel state invokes two or more actors no longer records a state hash that its own replay cannot reproduce. When a second child settled before the first child's completion was delivered, the hash on that completion's entry included the second child as `done`, while replay (which never starts children) holds it active, so resuming the thread from the store alone threw `AgentReplayDivergenceError`. Each entry's `verification.stateHash` is now taken from the pure fold of the log, the state `replay` reaches. Logs recorded without that race keep the same hashes; a log already recorded with the race still fails verification and can be resumed with its `snapshot` cache.
