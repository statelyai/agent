---
"@statelyai/agent": minor
---

**Declare models once.** `createAiSdkExecutors` and `createTanStackAiExecutors` now accept a machine built by `setupAgent(...).createMachine`, or the `setupAgent(...)` result itself, and read the `models` declared in `setupAgent({ models })`: `createAiSdkExecutors(machine)` replaces `createAiSdkExecutors({ models })` when the map is already on the setup. The options form is unchanged and still takes `settings`. A wrong-shaped argument, including a setup or machine that declared no models, now throws when the executors are built, naming what it got. Core stays provider-free.
