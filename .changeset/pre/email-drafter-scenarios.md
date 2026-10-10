---
"@statelyai/agent-demo": patch
---

Two email drafter scenarios: v1 asks about every missing detail before drafting, v2 drafts first and checks for a recipient at SEND. `demo/src/lib/email-drafter-compare.ts` runs both on the same requests and records clarification turns, model calls, tokens, send-rule violations, and edge traversal counts; `email-drafter-propose.ts` asks an agent for one bounded change given v1 and that evidence.
