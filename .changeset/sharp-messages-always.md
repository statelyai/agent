---
"@statelyai/agent": minor
---

Add first-class session messages and deterministic always transitions.

Agent states and snapshots now carry `messages` alongside `context`. State hooks receive messages, transition results can replace messages, and helper functions are exported for appending user, assistant, and system messages.

Machines can now define `always` transitions for deterministic eventless routing. Runtime sessions journal these transitions as internal events so persistence and restore remain replayable.
