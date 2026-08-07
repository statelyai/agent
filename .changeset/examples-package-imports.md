---
"@statelyai/agent": patch
---

Examples now import the package by name (`@statelyai/agent`, `@statelyai/agent/ai-sdk`, `@statelyai/agent/zod`) instead of relative `../../src/...` paths, so each example is copy-paste-able outside the repo. Repo-level tsconfig/vitest aliases keep those names resolving to `src/` for the local dev loop.
