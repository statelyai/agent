---
"@statelyai/agent": patch
---

`wrapWorkflow` observes an effect that resolves to a stream: `effect.done` carries the chunks once the stream is read (or the reader stops early), and a mid-stream throw is an `effect.error`.
`wrapWorkflow` hands the workflow its own deep copy of a plain-data input, so legacy code that mutates its input no longer throws on XState's frozen context.
`canReach` lists why a search is incomplete in `unexplored` when `complete` is false, such as a src with no `outputs` entry.
`checkParity` and `compareRecordings` report a run that returned on one side and threw on the other as an `output` divergence, and `checkParity` names the thrown error in its message.
`describeMachine` prints `→ ?` for a function transition whose target is a variable (including shorthand `{ target }`), and no longer marks a transition that always returns an object literal `(conditional)` because of a conditional in its context patch.
`wrapWorkflow` keeps a streaming generator's return value flowing to a manual `next()` loop and records it: `effect.done` carries `{ chunks, returned }` when the generator returned a value, and `next()` called on the generator itself is observed too.
`checkParity` takes `normalizeError(error, scenario)`, which maps each side's thrown error before the two are compared; rows keep the raw errors.
`describeMachine` leaves a spread of the current context (`{ ...ctx, outcome }`, or `{ context: e }` in minified source) out of the keys a transition sets.
`explorePaths` `done` terminals carry the machine's `output`.
