# The step API

`runAgent` is one host. Underneath it, an agent machine is a pure function: given a state and an event, it returns the next state and the model requests it is now waiting on. The step API exposes that function directly, so any host can run the same machine: a durable workflow, a queue consumer, a test, or a replay of a recorded log.

A step is a snapshot plus the requests still to resolve:

```ts no-check
interface AgentStep {
  snapshot: MachineSnapshot;
  requests: AgentStepRequest[]; // kind: "text" | "decision"
  actions: readonly ExecutableAction[];
  done: boolean;
}
```

Nothing in a step has executed. The host decides how and when each request runs.

## The loop

```ts
import {
  executeAgentRequest,
  initialAgentStep,
  resolveAgentStep,
  resolveDecision,
  transitionAgentStep,
} from "@statelyai/agent";
import type { AgentRequestExecutors } from "@statelyai/agent";
import type { AnyStateMachine } from "xstate";

export async function runWithSteps(
  machine: AnyStateMachine,
  input: unknown,
  executors: AgentRequestExecutors,
) {
  let step = initialAgentStep(machine, input);

  while (!step.done) {
    const [request] = step.requests;
    if (!request) break; // idle: resting on an external event

    if (request.kind === "decision") {
      const event = await resolveDecision(request, executors, {
        canTake: (candidate) => step.snapshot.can(candidate),
      });
      step = transitionAgentStep(machine, step, event);
    } else {
      const { result, messages } = await executeAgentRequest(request, executors);
      step = resolveAgentStep(machine, step, request, { result, messages });
    }
  }

  return step.snapshot;
}
```

- `initialAgentStep(machine, input)` starts the machine.
- `transitionAgentStep(machine, step, event)` applies an external event: a decision's chosen event, a human reply, a timer.
- `resolveAgentStep(machine, step, request, output)` delivers a text request's result as that invoke's `xstate.done.actor` event. `output` is the `{ result, messages }` envelope the invoke's `onDone` reads: the validated result plus the executor's response messages (`[]` when there are none).
- `rejectAgentStep(machine, step, request, error)` delivers a failure as `xstate.error.actor`, so the machine takes the invoke's `onError`. With no `onError` in scope the snapshot ends in `status: 'error'`, exactly as a live run would.
- `executeAgentRequest(request, executors)` runs one text request against the executor contract and returns `{ result, messages, raw }`: the validated result, the response messages, and the raw executor result. The first two are exactly what `resolveAgentStep` takes. Decisions go through `resolveDecision`.

Every step's snapshot is a native XState snapshot. To continue in another process, persist it with `getPersistedSnapshot(step.snapshot)`, and on the other side rehydrate it with `machine.resolveState(persisted)` before handing it to `transitionAgentStep`: a persisted snapshot is plain JSON, and `resolveState` rebuilds the live snapshot (state nodes, children) that `transition` expects.

```ts no-check
// process A
await store.put(id, getPersistedSnapshot(step.snapshot));

// process B
const snapshot = machine.resolveState(await store.get(id));
step = transitionAgentStep(machine, snapshot, event);
```

Requests in parallel regions arrive together in `step.requests`; the host chooses whether to run them concurrently.

## Replaying a failed call

A call that failed is replayed as the invoke's error, not its output:

```ts no-check
step = call.error
  ? rejectAgentStep(machine, step, call.id, call.error)
  : resolveAgentStep(machine, step, call.id, call.output);
```

The error value is whatever the host recorded. An `Error` is the usual one, and a plain object such as `{ code: "truncated" }` arrives at the `onError` transition as `event.error` untouched, so a machine can branch on a failure code. `simulateAgent` in `@statelyai/agent/testing` uses this to script failures with no model. See [scripted failures](verify.md#scripted-failures).

## Other hosts

- `runAgent` when an in-process actor is enough.
- `provideExecutors` when your application owns a live XState actor.
- `createDurable` from `xstate/durable` when a durable framework owns the effect lifecycle. The [`portable-xstate-loop`](../examples/portable-xstate-loop) example shows that shape.

The host decides how requests execute. That includes retries, tool-loop interruption behavior, persistence, concurrency, and scheduling.
