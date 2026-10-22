---
"@statelyai/agent": patch
---

Fixes from installing the package in an existing app for the first time.

- **Plain objects from another realm are JSON.** A jest test's vm context gives objects another `Object.prototype`, so `metadata`, store reads, and errors from there were rejected and a run could silently lose its log. The log's checks now accept them.
- **A run with a `store` fails rather than run unlogged** when its first entry cannot be written: `{ status: "error", cause: "journal" }`.
- **Journaled errors keep their `code`** (a string or a number), and `replay` turns them back into `Error` objects.
- **A throwing `onTrace`, `onTransition`, `onChunk`, or `onResult` no longer fails the run**; it is reported with `console.error`.
- **Reusing a thread id with different input throws `thread-input-mismatch`** instead of returning the other run's result.
- **`setupAgent` throws `invalid-schema` for a schema without `~standard`** (zod 3.23 and earlier) instead of skipping its validation.
- **`describeMachine` prints `?`** for a transition whose target comes from a helper call, instead of `(stays)`.
- **Subpath types resolve under `moduleResolution: "node"`** (`typesVersions`), and `engines` allows Node 22.
