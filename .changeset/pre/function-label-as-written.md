---
"@statelyai/agent": patch
---

`getInteraction` shows a function `label`'s result as written. Braces in it, such as a JSON argument, are no longer read as `{context.path}` placeholders and removed. A string `label` still interpolates.
