---
"@statelyai/agent": minor
---

**`runDurableAgent` timers.** `after(...)` delays now work on durable hosts, in two modes via `options.timers`:

- `'live'` (default): timers arm on real in-process `setTimeout`s; the run stays open until they fire and each firing is journaled (`{ type: 'xstate.timer', id }`), so a replay never re-waits.
- `'external'`: timers are recorded but never armed — the run settles `idle` with `pendingTimers: [{ id, delayMs }]`, the host schedules its own wake-up (a Durable Object alarm, a delayed message, a cron), and resumes with the timer's firing event. Stale firings (state already exited) are ignored by the machine, so at-least-once schedulers are safe.

Replayed frontiers never re-arm a timer whose firing is journaled, and an event that exits a delayed state cancels its timer through the adapter.
