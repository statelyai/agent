---
"@statelyai/agent": patch
---

`describeMachine` parses transition functions instead of matching them with regular expressions. Every return path counts: ternaries, `&&` and `||`, early returns, and local constants. A helper's target that the old matcher dropped now shows as `?`. The new `source: true` option prints each transition function under its line. Skills and `llms.txt` say to keep targets inline.
