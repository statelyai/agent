# Wrap a workflow, then carve it

Proof for [docs/strangler-fig.md](../../docs/strangler-fig.md): an existing
async workflow moved onto a machine with no rewrite, then one phase at a time,
with `checkParity` against the original at every step.

- **`before.ts`**: the workflow as it ships. `runTicket(ticket, effects)`
  classifies a ticket with a retry, looks up the order, applies a refund limit,
  and replies or escalates. Every side effect goes through `effects`.
- **`effects.ts`**: fake effects for tests: a scripted classifier that can fail
  with a 503, an order table, write logs.
- **`step0.ts`**: `wrapWorkflow` around `runTicket`, unchanged. Each effect call
  is an `effect.call` then `effect.done` transition.
- **`step1.ts`**: the classify retry loop becomes `classifying` and `retrying`
  states; the rest is `resolveTicket` from `before.ts`, invoked as one actor.
  Same `(ticket, effects)` signature.
- **`index.test.ts`**: `checkParity` for step 0 and step 1 against `before.ts`
  on five scenarios, a carve that drops the retry caught as a divergence, and a
  `canReach` proof that the classifier runs at most `MAX_ATTEMPTS` times.

## What each step buys

| Step | Change to `before.ts` | Gained                                                       |
| ---- | --------------------- | ------------------------------------------------------------ |
| 0    | none                  | transitions, traces, event log, `signal`, a golden recording |
| 1    | classify phase carved | a bounded retry, proven with `canReach`                      |

Run it: `pnpm vitest run examples/strangler-fig`.
