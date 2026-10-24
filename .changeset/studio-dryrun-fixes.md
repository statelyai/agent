---
"@statelyai/agent": patch
---

Fixes from installing the package in an existing app for the first time.

- **Plain objects from another realm are JSON.** A jest test's vm context gives objects another `Object.prototype`, so `metadata`, store reads, and errors from there were rejected and a run could silently lose its log. The log's checks now accept them.
- **A run with a `store` fails rather than run unlogged** when its first entry cannot be written: `{ status: "error", cause: "journal" }`.
- **Journaled errors keep their `code`** (a string or a number), and `replay` turns them back into `Error` objects. They carry an `"@error": true` marker, so a thrown plain `{ name, message }` replays as the plain object it was.
- **A throwing `onTrace`, `onTransition`, `onChunk`, `onResult`, `onEvent`, or `on` handler no longer fails the run**; it is reported with `console.error`.
- **Reusing a thread id with different input throws `thread-input-mismatch`** instead of returning the other run's result.
- **`setupAgent` throws `invalid-schema` for a schema without `~standard`** (zod 3.23 and earlier) instead of skipping its validation.
- **`describeMachine` prints `?`** for a transition whose target comes from a helper call, instead of `(stays)`.
- **Subpath types resolve under `moduleResolution: "node"`** (`typesVersions`), and `engines` allows Node 22.
- **`ai` peer floor is 7.0.128,** the first release with `experimental_decide`, which `@statelyai/agent/ai-sdk` imports.
- **Undefined fields are dropped from input and events** before they are journaled, as `JSON.stringify` drops them. Any other value the log cannot hold fails a run that has a `store`, and stops the log with a `console.warn` when it does not, instead of failing one way for input and another for events.
- **`setupAgent` throws `invalid-request`** for a request with neither `prompt` nor `messages`, instead of every call failing inside the invoke.
- **`ExploreSnapshot` and `CanReachTarget` types** from `@statelyai/agent/testing`, for exploration callbacks in an app whose own `xstate` is another version.
- **`CHANGELOG.md` ships in the package,** and a new "Upgrading between alphas" page lists the breaking changes since earlier alphas.
- **`runSeam`'s `respond` may return a promise,** so a seam eval can answer idle pauses with a real async client.
