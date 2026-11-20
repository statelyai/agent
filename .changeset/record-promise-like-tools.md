---
"@statelyai/agent": patch
---

Record and replay settled results from promise-like tools, including thenables and promises from another realm. These calls now retain their asynchronous return/rejection behavior and are tracked as running until settlement, so overlapping calls receive the correct concurrency marker. Ordinary synchronous tools remain synchronous.
