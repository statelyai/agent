---
"@statelyai/agent": patch
---

`canReach`, `explorePaths`, and `simulateAgent` validate `input` against the machine's input schema, as `runAgent` does. Input the schema rejects throws `AgentError` with code `invalid-machine-input`, and the parsed value (defaults filled) seeds the search. Before, a misspelled input field could report `reachable: false, complete: true` for a start state no run can reach.
