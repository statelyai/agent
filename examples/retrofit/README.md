# Retrofit a hand-rolled loop

Proof for [docs/from-a-loop.md](../../docs/from-a-loop.md): a genuinely tangled
agent, converted into an agent machine one shippable step at a time, with the
behavior pinned by tests the whole way.

- **`before.ts`** — the tangle you might actually ship: a support-ticket
  resolution agent on raw AI SDK `generateText`. A `while (true)` loop, phase
  tracked in mutable strings + boolean flags, tool choice in a nested `if/else`,
  an inline retry/backoff wrapper on every model call, a `$100` refund limit as
  an `if`, and a human-approval pause faked with a returned `{ pending }` sentinel
  plus a `resume()` closure that re-enters the loop. It works — and none of its
  state is serializable.
- **`step1.ts`** — phases become explicit states; the model calls (with the retry
  wrapper) move into a `generateText` executor, unchanged.
- **`step2.ts`** — the tool-choice `if/else` becomes `agent.decide` over typed
  events; the `$100` `if` becomes a guard.
- **`step3.ts`** — the `{ pending }` sentinel becomes an idle `awaitingApproval`
  state; `runAgent` settles idle, you persist the snapshot and resume with an
  event.
- **`index.ts`** — the final form (adds triage + an order-lookup tool), dual-mode
  via the shared harness.

Each step compiles, runs, and preserves the observable behavior.

## Your code → where it went

| In `before.ts` (the loop)           | In the machine                             |
| ----------------------------------- | ------------------------------------------ |
| `while (true)`                      | `runAgent` owns the loop                   |
| `phase` string + boolean flags      | explicit states                            |
| nested `if/else` tool dispatch      | `agent.decide` + typed events              |
| `if (amount > 100)` refund limit    | a guard on the REFUND transition           |
| retry/backoff wrapper               | a custom `generateText` executor           |
| `{ pending }` sentinel + `resume()` | an idle state + `persistedSnapshot`/resume |
| duplicated transcript bookkeeping   | context, written once per transition       |

## Run

```bash
OPENAI_API_KEY=... npx tsx examples/retrofit/index.ts   # the machine
OPENAI_API_KEY=... npx tsx examples/retrofit/before.ts  # the loop it replaces
```

Tests (`index.test.ts`) run keyless with mock executors:

```bash
pnpm vitest run examples/retrofit
```
