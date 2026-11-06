---
"@statelyai/agent": patch
---

Export `SetupAgentResult`, the return type of `setupAgent(...)`, so exporting a setup itself (`export const agentSetup = setupAgent(...)`) emits declarations under `declaration`/`composite` on TS 6 and 7 instead of failing with TS2883/TS7056.
