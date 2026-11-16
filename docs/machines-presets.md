---
title: Preset machines
description: createApprovalBatchMachine, a factory that gates one model turn's tool calls on approval and returns an ordinary, inspectable agent machine.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

`@statelyai/agent/machines` ships `createApprovalBatchMachine`, a factory over `setupAgent(...).createMachine(...)`.

- The result is an ordinary machine, with the same states, guards, snapshots, and `lintAgentMachine` support as a machine you write yourself.
- Executors stay separate. The preset names no SDK.

Other shapes are runnable examples to copy and edit. See [Agent patterns](patterns.md) for the full list.

- Prompt chain: [prompt-chaining](https://github.com/statelyai/agent/blob/next/examples/prompt-chaining/index.ts)
- Supervisor: [agent-supervisor](https://github.com/statelyai/agent/blob/next/examples/agent-supervisor/index.ts)
- Handoff: [swarm-handoff](https://github.com/statelyai/agent/blob/next/examples/swarm-handoff/index.ts)
- Fan-out: [parallel-streams](https://github.com/statelyai/agent/blob/next/examples/parallel-streams/index.ts) and [map-reduce](https://github.com/statelyai/agent/blob/next/examples/map-reduce/index.ts)
- Tool calls with review: [review-tool-calls](https://github.com/statelyai/agent/blob/next/examples/review-tool-calls/index.ts)

## `createApprovalBatchMachine`

One model turn's tool calls, each approved or rejected on its own. Only approved calls execute. No model call: the host maps the turn's calls to `input.calls` and feeds `output.results` back as tool results. See [Tools](tools.md#approval-gate).

```ts
import { createAsyncLogic } from "xstate";
import { createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import { createApprovalBatchMachine } from "@statelyai/agent/machines";

const machine = createApprovalBatchMachine({
  policy: createAsyncLogic({
    run: async ({ input }: { input: { call: { name: string } } }) =>
      input.call.name === "search" ? ("allow" as const) : ("ask" as const),
  }),
  execute: createAsyncLogic({
    run: async ({ input }: { input: { call: { name: string; args: unknown } } }) =>
      `ran ${input.call.name}`,
  }),
});

const paused = await runToQuiescence(createAgentRuntime(machine), {
  input: { calls: [{ id: "call_1", name: "deleteFile", args: { path: "a.txt" } }] },
});
const result = await runToQuiescence(createAgentRuntime(machine), {
  snapshot: paused.persist(),
  event: { type: "APPROVE", callId: "call_1" },
});
```

- **Input.** `{ calls: Array<{ id, name, args }> }`. Ids must be unique.
- **`policy`.** Actor logic over `{ call }` returning `"allow"`, `"ask"`, or `"deny"`. Default: every call is `"ask"`. A policy failure or any other value fails the call; it never executes.
- **`execute`.** Actor logic over `{ call }`. Its output is the call's `result`; a rejection is `status: "failed"`.
- **`executeWhen`.** `"allReady"` (default): nothing executes until every call has settled its approval. `"eachReady"`: each call executes once approved.
- **Child states.** `checking` (policy) → `awaitingApproval` → `approved` → `executing` → `executed` | `rejected` | `failed`. One spawned child per call, id `call:<id>`.
- **Host events.** `APPROVE`, `APPROVE_ALWAYS`, `REJECT` (optional `reason`), each with `callId`. Routed to that call's child; ignored for a call not awaiting approval. `CANCEL_ALL` ends the batch (state `cancelled`), stopping unfinished calls, including an in-flight execute, which reports `cancelled`.
- **Interaction.** `running` declares `meta.interaction` with one payload choice per awaiting call and verb, so `getInteraction(snapshot).choices` lists them. `context.awaiting` holds the calls themselves.
- **Output.** `{ results, approveAlways }`. `results` holds one `{ id, status, result?, error?, reason? }` per input call, in input order, with `status` `"executed"`, `"rejected"`, `"failed"`, or `"cancelled"`. `approveAlways` holds one `{ name }` per tool approved with `APPROVE_ALWAYS`; persist it and have `policy` return `"allow"` for those names next time.
- **Safety.** The per-call child reaches `executing` only from a policy `"allow"` or a person's approval. `canReach` proves the opposite unreachable with `complete: true`; see `src/machines/approval-batch.test.ts`.
- **Mid-run cancel.** `runtime.send({ type: "CANCEL_ALL" })` from a hand-written loop. See [Hosts](hosts.md#host-events-mid-run).

## Ejection

A preset is a starting point. When you need one more state, a human gate, a different bound, or your own typed context:

1. Open the preset's source at `src/machines/approval-batch.ts`.
2. Copy it into your project and edit the `setupAgent(...)` call directly.
3. Run it as before. The copied machine runs, lints, and persists the same way.

Examples to eject toward:

- [review-tool-calls](https://github.com/statelyai/agent/blob/next/examples/review-tool-calls/index.ts): an approval gate.

## Versioning

The preset machine carries `version: "1"`, using XState's standard `createMachine({ version })` prop. This is the machine's own topology version. It is unrelated to the `@statelyai/agent` package version. Native persisted snapshots and trace events carry that version:

```ts
const result = await runToQuiescence(createAgentRuntime(machine, { executors }), { input });
// result.persist().version === "1"
```

The versioning policy:

- The version identifies the machine's topology, not the release that built it. Prompt wording can change without a version bump.
- A topology change that an old snapshot cannot restore bumps the version. Migrate it with XState's machine-level `migrate(snapshot, fromVersion)`.

The same prop works for your own machines. Set `version` in `createMachine(...)` and `runToQuiescence` stamps that value instead of the structural hash, which changes on any edit.

## Related

- Read more about [Agent machines](machines.md), including `setupAgent`, states, invokes, and guards.
- Read more about [Agent patterns](patterns.md), the full runnable example catalog.
- Read more about [Persistence](persistence.md).
