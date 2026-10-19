---
title: Migrating from a hand-rolled loop
description: Convert a while-loop agent into an agent machine one step at a time, then improve a factory loop's triage from its traces.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page ports a working `while`-loop agent to an agent machine without rewriting your model calls. Your SDK calls, tools, and retry logic become the [executors](hosts.md). The machine replaces only the control flow.

Part 1 (Steps 1–5) ports a support agent and ends on the tests the port makes possible. [Part 2](#part-2-a-factory-loop-that-improves) (Steps 6–11) ports a software-factory loop and improves its triage from traces without loosening its rules.

Part 1's code is in `examples/port-walkthrough`:

- [`before.ts`](../examples/port-walkthrough/before.ts): the loop, runnable with `OPENAI_API_KEY=... npx tsx examples/port-walkthrough/before.ts`.
- [`index.ts`](../examples/port-walkthrough/index.ts): the machine, and a `runSupportAgent` with the loop's signature and result type.
- [`index.test.ts`](../examples/port-walkthrough/index.test.ts): four tests that run without an API key.

The loop's model call is this:

```ts no-check
const { toolCalls, text, response } = await generateText({
  // Model IDs here are illustrative; substitute your provider's current models.
  model: openai("gpt-5.4-mini"),
  messages,
  tools: { search, sendEmail },
});
```

The port's call site is this:

```ts no-check
const result = await runAgent(supportLoopMachine, {
  input: { request },
  executors,
});
```

The `generateText` call still exists. It moves into the executors, and the loop around it becomes the machine. The result carries `result.output`, the live `result.snapshot`, native `result.persist()`, and aggregated `result.usage`.

For the design work behind this refactor, read [Thinking in state machines](thinking-in-state-machines.md). It covers how to find the states in a loop before you write any of them down.

## What stays the same, what changes

The model work moves into executors unchanged. The control flow around it changes in six places.

| Area                     | In the loop                                           | With `runAgent`                                                                                                                                                                            | Why                                                                       | Read more                                                                   |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Same: SDK call           | `generateText` with your options                      | The same call inside an executor, written by hand or through an adapter such as `createAiSdkExecutors`                                                                                     | Executors are host code; the machine never calls a provider               | [Hosts](hosts.md)                                                           |
| Same: tools              | The SDK runs the tool-call loop                       | The request's `tools` reach the executor, and the SDK still runs the tool-call loop. With the AI SDK adapter, `maxSteps` becomes `stopWhen`                                                | A tool loop inside one state is one request                               | [Hosts](hosts.md#ai-sdk-adapter)                                            |
| Same: messages           | Your message array                                    | A request's `messages` reach the executor without conversion                                                                                                                               | Messages stay framework-native                                            | [Messages](messages.md)                                                     |
| Same: retries and errors | Your retry and `try`/`catch` code                     | The same code inside the executor. Core does not retry a text request                                                                                                                      | Retry policy belongs to the SDK or the executor                           | [Hosts](hosts.md#executor-owned-structured-retries)                         |
| Same: model              | A provider model object                               | The same object, registered in `models` and named by key in the request                                                                                                                    | The machine names a model; the host resolves it                           | [Models and providers](models-and-providers.md)                             |
| Same: token usage        | Read off each response                                | Each executor returns `usage`; `result.usage` sums it for the run, plus `modelCalls`                                                                                                       | Core reads only what the executor reports                                 | [Usage and budgets](usage-and-budgets.md#the-usage-result)                  |
| Changes: human wait      | `await approve(...)` blocks the process               | The run settles `{ status: "idle" }`. Resume with `runAgent(machine, { snapshot, event })`, or pass `onIdle` to keep the blocking shape                                                    | A pause can outlive the process; the persisted snapshot is plain JSON     | [Human in the loop](human-in-the-loop.md)                                   |
| Changes: call cap        | Your own step counter, or none                        | `maxModelCalls` defaults to `100`. Pass a higher value to raise it. The overrun reaches the invoke's `onError`, or settles `{ status: "error", cause: "max-model-calls" }`                 | A runaway loop stops at a fixed budget                                    | [Usage and budgets](usage-and-budgets.md#the-global-backstop-maxmodelcalls) |
| Changes: timers          | `setTimeout` or a sleep in the loop                   | Root `after` timers run in process by default, and the run waits for them. A durable host passes `timers: { schedule, cancel }` and delivers `{ type: "xstate.timer", id }` when one fires | A timer can outlive the process                                           | [The runtime loop](steps.md#host-owned-timers)                              |
| Changes: unknown events  | Your code decides: a `switch` falls through or throws | An event the current state does not handle is ignored. The run settles normally and returns the event as `result.ignored`                                                                  | A stale or duplicate answer is not a failure                              | [Persistence](persistence.md#resume-with-an-event-off-the-wire)             |
| Changes: input           | Passed to the first prompt unchecked                  | Validated against the machine's input schema before the run starts. Invalid input throws `AgentError` with code `invalid-machine-input`                                                    | Bad input fails before any model call                                     | [Machines](machines.md#schema-declarations)                                 |
| Changes: executor errors | A thrown SDK error rejects the loop's promise         | The error goes to the invoke's `onError`. With no `onError`, the run settles `{ status: "error", cause: "machine" }` with the error and the snapshot                                       | The machine routes failures as transitions; the result keeps the snapshot | [Machines](machines.md#request-and-actor-invokes)                           |

## Starting point: a hand-rolled loop

The starting point is a support agent written as a `while` loop against the AI SDK. The model calls `search` freely, and it can call `sendEmail`, which a human must approve. The full loop is in [`before.ts`](../examples/port-walkthrough/before.ts). Its control flow is these lines:

```ts no-check
if (steps++ >= 8) return { sent, stopped: "step-limit" };
// ...
if (!toolCalls?.length) return { sent, reply: text };

for (const call of toolCalls) {
  if (call.toolName === "sendEmail") {
    if (!(await approve(call.input))) return { sent, pending: true }; // loop state is lost here
    sent = true;
  }
}
```

The loop returns one of three shapes. `before.ts` names them so the port can be checked against them:

```ts
export type SupportResult =
  | { sent: boolean; stopped: "step-limit" }
  | { sent: boolean; reply: string }
  | { sent: boolean; pending: true };
```

This loop has four problems:

- `generateText` runs a tool's `execute` in the same call that returns `toolCalls`. By the time the loop asks `approve`, `sendEmail` has already run.
- The approval rule is an `if` statement inside the tool loop, so no test can list the paths around it.
- The human pause returns `{ pending: true }` and discards the loop's state, so the run cannot resume.
- The step cap is a local counter. A test reaches it only by spending eight model calls.

## Step 1: implicit phases as explicit states

Each line of the loop becomes a state in [`index.ts`](../examples/port-walkthrough/index.ts):

| In the loop                                    | In the machine                                     |
| ---------------------------------------------- | -------------------------------------------------- |
| `if (steps++ >= 8)`                            | The `checkingSteps` choice state                   |
| `generateText` with `search`                   | The `assisting` state, which invokes `assist`      |
| `if (!toolCalls?.length)`                      | The `deciding` state, which invokes `agent.decide` |
| `await approve(call.input)`                    | The idle `awaitingApproval` state                  |
| `sendEmail`'s `execute`                        | The `sending` state, which invokes `sendEmail`     |
| `return { sent, reply }`, `pending`, `stopped` | The final states `replied`, `declined`, `failed`   |

The loop's first line becomes the machine's initial state. A choice state compares the counter against an exported constant:

```ts no-check
// The loop's first line: `if (steps++ >= 8) return { sent, stopped: "step-limit" }`.
checkingSteps: {
  type: "choice",
  choice: ({ context }) =>
    context.steps >= MAX_STEPS ? { target: "failed" } : { target: "assisting" },
},
```

`setupAgent` declares the context, events, request, and actor. Its `output` schema lists the loop's three returns, one per final state:

```ts no-check
// The loop's three returns, one per final state.
output: z.union([
  z.object({ sent: z.boolean(), stopped: z.literal("step-limit") }),
  z.object({ sent: z.boolean(), reply: z.string() }),
  z.object({ sent: z.boolean(), pending: z.literal(true) }),
]),
```

A tool the machine must gate is not a tool any more. `sendEmail` becomes an actor the machine invokes, written with XState's `createAsyncLogic`. `createAsyncLogic` takes `{ schemas, run }`. Annotate `run`'s return type when it resolves an array or another literal; the schema type parameters are `const`, so an unannotated array literal infers as a readonly tuple.

<!-- viz: support loop machine: checkingSteps -> assisting (text request with the search tool) -> deciding (agent.decide) -> awaitingApproval (SEND_EMAIL) -> sending (APPROVE) -> checkingSteps; deciding -> replied (REPLY); deciding -> checkingSteps (CONTINUE); awaitingApproval -> declined (REJECT); checkingSteps -> failed (MAX_STEPS) -->

## Step 2: free tools stay tools, the gated action becomes a decision

A converted loop splits its tools in two, and the split is the whole refactor:

| In the loop                           | In the machine                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A tool with no side effect you gate   | Stays a tool on a [text request](text-requests.md). The host runs the tool loop inside one state.    |
| A tool a human or a rule must approve | Becomes an event the model proposes through `agent.decide`, plus a state that invokes the real work. |

`search` is the first kind. `index.ts` imports it from `before.ts` and passes it to the `assist` request as `tools: { search }`. The machine stays in `assisting` for every search turn and sees one `onDone`.

`sendEmail` is the second kind. The model no longer calls it. In `deciding`, the model chooses one of three events: `REPLY` ends the run, `CONTINUE` starts another round, and `SEND_EMAIL` proposes a draft:

```ts no-check
on: {
  REPLY: { target: "replied" },
  CONTINUE: { target: "checkingSteps" },
  SEND_EMAIL: ({ event }) => ({
    target: "awaitingApproval",
    context: { draft: { to: event.to, subject: event.subject, body: event.body } },
  }),
},
```

A tool-carrying request and a decision are two different states. The request is one model call that may run many tool turns inside the host. The decision is one model call that returns exactly one event the current state accepts.

Rules that were `if` statements can move into the transition instead of a separate state. A transition function that returns `undefined` rejects the choice, and the decision retries with typed feedback. See [transitions](machines.md#transitions) and [Decisions](decisions.md).

## Step 3: the pause as an idle state

The loop's `return { sent, pending: true }` becomes `awaitingApproval`, a state with no invoke. `runAgent` settles as `idle` in that state instead of discarding the run. The snapshot is plain JSON, so you can persist it anywhere.

`APPROVE` is the only way into `sending`, and it is the only writer of `approved`:

```ts no-check
on: {
  APPROVE: () => ({ target: "sending", context: { approved: true } }),
  REJECT: { target: "declined" },
},
```

`REJECT` lands in `declined`, whose output is the loop's `{ sent, pending: true }`, so callers do not change. After `sending`, the machine returns to `checkingSteps`, as the loop continued after a send.

The state's `meta.interaction` block is what a host renders for the pause. `setupAgent` types it against the machine's events, so a choice naming an undeclared event does not compile. See [Human in the loop](human-in-the-loop.md).

## Step 4: the run with `runAgent`

The loop ran N turns. Its replacement is one `runAgent` call with `onIdle`. Each time the machine pauses on a human, `runAgent` calls `onIdle` with the idle snapshot, then resumes from the persisted snapshot with the event `onIdle` returns. The loop's `approve` callback becomes `onIdle`:

```ts no-check
const result = await runAgent(supportLoopMachine, {
  input: { request },
  executors,
  onIdle: async (snapshot) =>
    (await approve(snapshot.context.draft))
      ? { type: "APPROVE" as const }
      : { type: "REJECT" as const },
});
```

With `onIdle`, the call returns only `done` or `error`. `runSupportAgent` in [`index.ts`](../examples/port-walkthrough/index.ts) wraps this call with the loop's signature: it returns `result.output` and rethrows a run that settles `error`. The invokes have no `onError`, so an SDK error still rejects the call, as it did in the loop.

For a single leg that hands the pause back to a caller, leave out `onIdle` and resume later with a second `runAgent` call that passes `{ snapshot, event }`. This is the form an HTTP handler wants, because the pause outlives the request. The third test below runs it. [Use in any stack](any-stack.md) runs one machine in local, Express, and Cloudflare hosts. See [Choosing a run mode](choosing-a-run-mode.md) for the full set.

The executors hold your existing model code:

- The `createAiSdkExecutors` adapter wraps the AI SDK. `runSupportAgent` uses it by default.
- Another SDK, or a raw `fetch`, is three plain functions that return `{ result }`. See [Hosts](hosts.md).
- The tools, retry logic, and provider calls you already wrote move across unchanged.

A host that drives the transition loop itself uses `createAgentRuntime`. See [Write your own host loop](hosts.md#write-your-own-host-loop).

## Step 5: the tests

[`index.test.ts`](../examples/port-walkthrough/index.test.ts) has four tests. None of them needs an API key or network access. Each one starts with a comment naming what the `while` loop could not test.

The model is `examples/mock-model.ts`: the AI SDK's `MockLanguageModelV3` behind the real `createAiSdkExecutors` adapter. Answers are keyed by request name, `assist` for the text request and `chooseAction` for the decision.

### The port runs with no key

The loop builds its model inside the function, so it runs only against a live provider. The port takes executors, so the test passes the mock:

```ts no-check
const executors = createMockModelExecutors({
  text: { assist: "Your duplicate charge is refunded." },
  decisions: { chooseAction: { type: "REPLY" } },
});

const output = await runSupportAgent(request, never, executors);

expectTypeOf(output).toEqualTypeOf<Awaited<ReturnType<typeof runLoop>>>();
expect(output).toEqual({ sent: false, reply: "Your duplicate charge is refunded." });
```

`runLoop` is `before.ts`'s `runSupportAgent`, imported as a type only. The `expectTypeOf` line fails `pnpm run typecheck:examples` if the port's result type drifts from the loop's.

### The step limit settles `done`

The decision answers `CONTINUE` every time, so the run spends its whole budget:

```ts no-check
const result = await runAgent(supportLoopMachine, { input: { request }, executors });

expect(result.status).toBe("done");
if (result.status !== "done") return;
expect(result.snapshot.value).toBe("failed");
expect(result.output).toEqual({ sent: false, stopped: "step-limit" });
expect(executors.calls.filter((call) => call.name === "assist")).toHaveLength(MAX_STEPS);
```

The run ends in the `failed` final state with the loop's `stopped: "step-limit"` output. It does not throw. The test also counts the `assist` calls, which the loop's local counter never exposed.

### The approval pauses and resumes

The decision proposes `SEND_EMAIL`, and the run settles `idle`. The test round-trips the snapshot through JSON and resumes with `APPROVE`:

```ts no-check
const paused = await runAgent(supportLoopMachine, { input: { request }, executors });
expect(paused.status).toBe("idle");
expect(paused.snapshot.value).toBe("awaitingApproval");

const restored = JSON.parse(JSON.stringify(paused.persist()));
const resumed = await runAgent(supportLoopMachine, {
  executors,
  snapshot: restored,
  event: { type: "APPROVE" },
});
```

The resumed run sends the email, takes another round, and ends with `{ sent: true, reply }`. The loop returned `{ pending: true }` at this point and had nothing to resume.

### No path sends without approval

`canReach` enumerates every decision branch and every human answer with no model calls. The target is a snapshot predicate: the machine is in `sending` and `approved` is `false`.

```ts no-check
const sendsUnapproved = await canReach(
  supportLoopMachine,
  (snapshot) => snapshot.matches("sending") && !snapshot.context.approved,
  everyPath,
);

expect(sendsUnapproved.reachable).toBe(false);
```

`everyPath` scripts the `assist` text and the `sendEmail` output, and sets `maxDepth` and `maxPaths` high enough that all 766 paths through the eight rounds are explored. The loop's approval was an `if` inside the tool loop, and no test could list the paths around it. Here the claim holds for every path. See [Testing and verification](verify.md) for `explorePaths`, `simulateAgent`, and `lintAgentMachine`.

## Part 2: a factory loop that improves

Part 2 starts from a working software factory. An author writes a patch, a self-check and an independent review run in parallel, and the task's visible tests run. Then the loop ships, retries, or asks a person.

The loop works. Part 2 makes its triage improve from its own runs, and keeps its rules fixed: nothing ships without passing checks and approval, three autonomous rounds at most, and a task whose spec is broken goes to a person.

The code is in `examples/code-review-loop`:

- [`before.ts`](../examples/code-review-loop/before.ts): the factory as a `while` loop with plain injectable dependencies. [`before.test.ts`](../examples/code-review-loop/before.test.ts) runs it with fakes.
- [`environment.ts`](../examples/code-review-loop/environment.ts): the same factory as a machine.
- [`policies/`](../examples/code-review-loop/policies): the triage policy versions, as JSON configs. [`policy.ts`](../examples/code-review-loop/policy.ts) runs one as the triage decider.
- [`run.ts`](../examples/code-review-loop/run.ts): runs the tasks on Claude Code in headless mode. `--improve` runs one improvement round.

The loop's body is this:

```ts no-check
while (round < 3) {
  patch = await deps.writePatch({ task, round, previous: patch, feedback });
  round++;
  const [self, review] = await Promise.all([
    deps.selfCheck({ task, patch }),
    deps.reviewPatch({ task, patch }),
  ]);
  const checks = await deps.runChecks({ taskId: task.id, file: task.file, patch });

  if (checks.passed && review.approved && self.ok) {
    return { outcome: "shipped", rounds: round, humanApproved: false, patch };
  }
  if (review.issues.some((issue) => issue.severity === "novel")) {
    return escalate("the reviewer marked an issue novel");
  }
  // feedback = the failing tests, the review issues, and the self-check concerns
}
return escalate("round cap");
```

Each dependency takes the input and returns the output of the matching machine request or actor. `escalate` calls `askHuman` and returns the person's answer as the result.

This loop has three problems:

- The rules and the triage share one function. To change when the loop escalates, you edit the function that holds the ship rule, and no test lists the paths around it.
- A thrown dependency ends the whole run. In `before.test.ts`, a reviewer outage in round 2 throws out of `runFactory`. The patch and the feedback lived in local variables, and no person is asked.
- `escalate` blocks the process on `askHuman`, as `approve` did in Part 1.

## Step 6: the factory as a machine

Port the loop as in Steps 1–4. Each line of `before.ts` becomes one construct in `environment.ts`:

| In `before.ts`                                          | In `codeReviewLoopMachine`                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `await deps.writePatch(...)`                            | The `generating` state, which invokes the `writePatch` request                        |
| `await Promise.all([selfCheck(...), reviewPatch(...)])` | The `verifying` parallel state: one region per invoke, and `onDone` after both        |
| `await deps.runChecks(...)`                             | The `checking` state, which invokes the `runChecks` actor                             |
| `while (round < 3)`                                     | `MAX_ROUNDS` as `context.roundLimit`, read by `triaging` and `retryBlocker`           |
| `if (checks.passed && review.approved && self.ok)`      | The `triaging` choice state, through `autoShippable`                                  |
| `if (review.issues.some(... "novel"))`                  | `retryBlocker`, the guard on `RETRY`                                                  |
| `feedback = ...`                                        | The `feedback` of a `RETRY` event, built by `triagePayloads`                          |
| `await deps.askHuman(...)`                              | The idle `humanReview` state, with `meta.interaction`                                 |
| `return { outcome: ... }`                               | The final states `shipped`, `rejected`, `failed`, and the `illegallyShipped` sentinel |

The ship check is a choice state. It runs before any model is asked to triage:

```ts no-check
triaging: {
  type: "choice",
  choice: ({ context }) => {
    if (autoShippable(context)) return { target: "checkingShip" };
    if (context.round >= context.roundLimit) {
      return { target: "humanReview", context: { escalation: `Round cap: ...` } };
    }
    return { target: "deciding" };
  },
},
```

- An invoke failure is a transition. A failed review records `approved: false` with a `novel` issue, so the same outage leaves the run idle in `humanReview` with the round-2 patch. The last test in `before.test.ts` runs the outage through both.
- `checkingShip` checks the ship rule a second time, written independently of `autoShippable`. A ship that breaks it lands in `illegallyShipped`, a final state that exists to be proven unreachable in Step 10.

## Step 7: rules as guards, judgment as a decision

Split what must always hold from what a model can learn:

| Kind     | In the loop                                | In the machine                                                                       |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Rule     | Ship only with passing checks and approval | `autoShippable` in `triaging`, re-checked by `checkingShip`; or a person's `APPROVE` |
| Rule     | At most 3 rounds                           | `roundLimit`, read by `triaging` and `retryBlocker`                                  |
| Rule     | A novel issue is not retried               | `retryBlocker`, the guard on `RETRY`                                                 |
| Judgment | Fixed: retry until the cap                 | `deciding`: `RETRY` with which feedback, or `ESCALATE` with which reason             |

`retryBlocker` returns why `RETRY` is refused, or `undefined`:

```ts no-check
export function retryBlocker(facts: Facts): string | undefined {
  if (facts.round >= facts.roundLimit) {
    return `round cap reached (${facts.round} of ${facts.roundLimit})`;
  }
  if (facts.review?.issues.some((issue) => issue.severity === "novel")) {
    return "the reviewer marked an issue novel";
  }
  if (unattributedFailure(facts)) return "the checks failed outside every visible test";
  return undefined;
}
```

The decision is a [closed choice](decisions.md#closed-choices). `triageInput` passes model `"triage"`, `allowedEvents: ["RETRY", "ESCALATE"]`, and `payloads` from `triagePayloads`: one `RETRY` per feedback focus, none while `retryBlocker` refuses it, and one `ESCALATE` per fixed reason. The `RETRY` transition checks the guard again:

```ts no-check
deciding: {
  invoke: { id: "triage", src: "agent.decide", input: ({ context }) => triageInput(context) },
  on: {
    RETRY: ({ context, event }) =>
      retryBlocker(context)
        ? undefined
        : { target: "generating", context: { feedback: event.feedback } },
    ESCALATE: ({ event }) => ({
      target: "humanReview",
      context: { escalation: `Escalated: ${event.reason}.` },
    }),
  },
},
```

- Shipping is not an event the decider can pick. No triage answer ships a patch.
- Model `"triage"` resolves to the policy: a JSON `AgentWorkflowConfig` that `createPolicyDecide` runs as the decide executor. `v0` retries until the cap. `v1` asks a `classifyIssue` judgment whether the task itself is broken and escalates early. See [Environment and policy](environment-and-policy.md).

## Step 8: the goal and the score

The goal is the machine's `description`. [`describeMachine`](machines-as-data.md#machine-descriptions-for-models) renders it first, so a model that proposes a policy reads the goal before the states.

```ts no-check
description: REVIEW_GOAL, // "Ship a patch for each coding task that passes its visible checks, ..."
```

The objective is `scoreEpisode` in `bench.ts`. It reads ground truth: the final state, and hidden tests that run only on what shipped.

| Outcome                                                   | Score |
| --------------------------------------------------------- | ----- |
| Shipped, hidden tests pass (a person's approval included) | 1     |
| Escalated a task labeled `novel-expected`                 | 1     |
| Escalated a task labeled `resolvable`                     | 0.5   |
| Shipped, hidden tests fail                                | 0     |
| Failed without escalating                                 | 0     |

Each round subtracts 0.05, floored at 0. A batch with any run in `illegallyShipped` scores `-Infinity`.

- Escalating a novel task scores the same as a clean ship after the same number of rounds. A policy is never penalized for asking a person; it pays only for the rounds it spent first.
- People write the task labels and the hidden tests. No model grades a run.

## Step 9: one trace per task

Pass a store and a thread id to the runtime. `runEpisode` in `bench.ts` names each thread `<split>/<policyVersion>/<taskId>`:

```ts no-check
createAgentRuntime(codeReviewLoopMachine, {
  executors: options.executors,
  actors,
  store, // run.ts passes createFileEventLogStore(tracesDir): one JSONL file per thread
  threadId, // `${task.split}/${policyVersion}/${task.id}`
});
```

- Every model output, check result, and human answer is an entry in the thread. A person's answer resumes the run from the thread.
- `getDecisionAttempts(entries)` lists the triage answers the machine refused before one landed. See [Decision attempts](event-log.md#decision-attempts).
- `listThreads({ prefix: "train/<version>/" })` returns one split. The improvement round reads train threads only. See [Stores](event-log.md#stores).

## Step 10: the ship proof

`canReach` searches every path to the `illegallyShipped` sentinel. The proof in `environment.test.ts` forks every invoke over a table of outputs and a failure, every triage answer, and every human answer:

```ts no-check
const violation = await canReach(codeReviewLoopMachine, "illegallyShipped", {
  input: { taskId: "slugify" },
  payloads: () => ({
    RETRY: [{ feedback: "explore", focus: "all" }] /* REQUEST_CHANGES, REJECT */,
  }),
  outputs: {
    reviewPatch: [
      { approved: true, issues: [] },
      { approved: false, issues: [issue("major")] },
      { approved: true, issues: [issue("novel")] },
      // ...
    ],
    runChecks: [/* passed, a visible test failed, an unknown test failed, a crash */],
  },
  errors: { reviewPatch: failure, runChecks: failure, "agent.decide": failure /* ... */ },
  dedupeBy: projection,
  maxDepth: 6 * MAX_TOTAL_ROUNDS + 6,
});

expect(violation).toMatchObject({ reachable: false, complete: true });
```

- The outputs are not tied to a patch, so the proof covers every author, reviewer, and test result in the table, not only the fixtures. `complete: true` makes `reachable: false` a proof within the round ceiling. See [Reachability checks](verify.md#reachability-checks).
- The machine's guards judge every event a policy proposes, so the proof holds for every policy. A promoted policy needs no new proof.
- A copy of the machine whose ship check forgets the reviewer fails the same search, with a witness path that ends in a passing `runChecks`. The loop's `if` has no such test.

## Step 11: an improvement round

Improvement is an explicit step. No policy changes while tasks run. Run one round:

```bash
pnpm exec tsx examples/code-review-loop/run.ts --improve --policy v0
```

`improvePolicy` in `improve.ts` runs these steps:

1. Run the train and held-out tasks with the current policy. The traces go to the store.
2. Reflect: one `proposePolicy` request with the goal, the objective, both machines as `describeMachine` text, and the train trails. It returns one candidate config.
3. Gate: `verifyAgentConfig` runs `validate`, `vocabulary`, `lower`, `lint`, and `explore`. An `outputs` probe then checks that every answer is an offered option. A failing gate's `detail` goes back as a repair prompt, up to 3 times.
4. Replay the train and held-out tasks with the candidate.
5. Promote only with zero violations on both splits, a held-out objective no lower than before, and a combined objective strictly higher. `run.ts` writes a promoted policy to `policies/current.json`.

Inside Claude Code, the [`improve-machine` skill](https://github.com/statelyai/agent/blob/main/skills/improve-machine/SKILL.md) runs the same round with Claude Code as the improver:

```bash
mkdir -p .claude/skills && cp -R skills/improve-machine .claude/skills/
pnpm exec tsx examples/code-review-loop/run.ts --policy v0 --no-human
claude -p "Use the improve-machine skill on examples/code-review-loop. ..."
```

The full prompt and its allowed tools are in the [example's README](../examples/code-review-loop/README.md#inside-claude-code-with-the-improve-machine-skill).

- One change per round. People own the environment, the goal, the objective, and the task split.
- With the mock executors in `improve.test.ts`, one round from `v0` promotes `v1`: the combined objective rises from 0.900 to 0.925, and the held-out objective from 0.900 to 0.933.

## Related

- [retrofit](../examples/retrofit/index.ts): a larger loop refactored one step at a time, in the order `before.ts`, `step1.ts`, `step2.ts`, `step3.ts`, and `index.ts`.
- [Overview](index.md): what the machine gives you over the loop.
- [Human in the loop](human-in-the-loop.md): idle states, `meta.interaction`, and resuming.
- [Environment and policy](environment-and-policy.md): the fixed environment, the generated policy, the objective, and the improvement loop.
- [code-review-loop](../examples/code-review-loop): Part 2's factory: `before.ts`, the machine, the policies, and the improvement round on Claude Code.
- [`skills/improve-machine`](https://github.com/statelyai/agent/blob/main/skills/improve-machine/SKILL.md): one improvement round from traces, run by an agent.
