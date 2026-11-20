---
"@statelyai/agent": minor
---

`verifyAgentConfig`'s `lint` gate checks the config's state graph: `unreachable-state` (a state that is not initial and that no reachable transition targets), `state-cannot-finish` (a reachable leaf state with no path to a final state, which `explore.dedupeBy` hides from exploration; `lint.terminalStates` allows states that wait forever on purpose, and a config with no final state skips it), `decide-event-unhandled` (an exact `allowedEvents` entry that no state active with the deciding state handles with that exact key), and `decide-event-without-schema` (an event a decision may send with no `schemas.events` entry). All four are errors. The result also carries `explore`, one `explorePaths` report per `explore.inputs` entry, when every configured input returned a report.
