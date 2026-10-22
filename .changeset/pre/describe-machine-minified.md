---
"@statelyai/agent": patch
---

`describeMachine` marks a transition function as `(conditional)` when its source is minified (`void 0`, a ternary with no spaces), as bundlers and `tsx` print it.
