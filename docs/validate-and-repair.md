---
title: Validate and repair model output with a loop
description: Check model output with your own host code, feed the rejection back as a repair prompt, and cap the loop in the machine.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page builds a machine that asks a model for output, validates it with the app's own code, and sends the rejection back to the model as a repair prompt, up to a fixed number of rounds. The worked version is [examples/generate-and-repair](../examples/generate-and-repair/index.ts).

## When to use this

Use a repair loop when validity is a question your code answers, not the schema. A [structured request](text-requests.md#structured-output-vs-plain-text) already guarantees the output parses and matches its schema; core rejects anything else before the machine sees it. What a schema cannot check is whether the output means anything: whether the SQL runs against your tables, whether the machine config's transitions name states that exist, whether the cited document ID is in your corpus. Answering that needs the database, the parser, or the corpus, so it happens in a host actor.

Two other mechanisms handle narrower cases:

- **SDK-level JSON repair**, such as the AI SDK's `experimental_repairText`, patches malformed JSON before parsing. It is syntactic and single-shot: one pass, no model call, no knowledge of your domain. It fixes a truncated brace. It does not know that `"open"` is not a state.
- **Decision retries** re-ask the model when it picks an event the machine will not accept. That is [decisions](decisions.md), and the legal set is already in the prompt.

A repair loop is the case left over: a semantic rejection, described in words, sent back as a new model call.

## The machine

Six states. Model calls are invokes; the branching is the machine's.

```ts no-check
initial: "generating",
states: {
  generating: {
    // Three invokes of the same request: the fan-out is in the machine.
    invoke: ["generateConfig1", "generateConfig2", "generateConfig3"].map((id) => ({
      id,
      src: "generateConfig",
      input: ({ context }) => ({ prompt: context.prompt }),
      // Targetless: the slot records its draft and the other two keep running.
      onDone: ({ context, output }) => ({
        context: { pending: [...context.pending, output], settled: context.settled + 1 },
      }),
      onError: ({ context, event }) => ({
        context: { settled: context.settled + 1, failureReason: reasonFor(event.error) },
      }),
    })),
    // Leave only once every slot has settled, either way.
    always: ({ context }) => {
      if (context.settled < 3) return;
      const [candidate, ...rest] = context.pending;
      return candidate === undefined
        ? { target: "failed" }
        : { target: "parsing", context: { candidate, pending: rest } };
    },
  },
  parsing: {
    invoke: {
      src: "parseConfig", // the host's validator
      input: ({ context }) => ({ text: context.candidate }),
      onDone: ({ output }) => ({ target: "done", context: { config: output } }),
      onError: ({ context, event }) => {
        const error = errorMessage(event.error);
        const [next, ...rest] = context.pending;
        // Try the next candidate before spending a repair.
        return next === undefined
          ? { target: "checkingRepairBudget", context: { lastError: error } }
          : {
              target: "parsing",
              reenter: true,
              context: { candidate: next, pending: rest, lastError: error },
            };
      },
    },
  },
  checkingRepairBudget: {
    type: "choice",
    choice: ({ context }) =>
      context.repairs < context.maxRepairs
        ? { target: "repairing" }
        : { target: "failed", context: { failureReason: `No valid config after ${context.maxRepairs} rounds.` } },
  },
  repairing: {
    invoke: {
      src: "repairConfig",
      input: ({ context }) => ({
        prompt: context.prompt,
        code: context.candidate,
        error: context.lastError ?? "unknown error",
      }),
      onDone: ({ context, output }) => ({
        target: "parsing",
        context: { candidate: output, pending: [], repairs: context.repairs + 1 },
      }),
      onError: { target: "failed" },
    },
  },
  done: { type: "final", output: ({ context }) => ({ summary: summarize(context), config: context.config, repairs: context.repairs }) },
  failed: { type: "final", output: ({ context }) => ({ summary: context.failureReason ?? "", config: null, repairs: context.repairs }) },
}
```

Four things are worth reading off that shape.

`generating` fans out by invoking the same request three times. The concurrency is a fact about the state, not a hidden option on the request, and the `always` transition is the join: nothing leaves `generating` until all three slots have settled.

`parsing` re-enters itself while candidates remain. The transition sets `reenter: true`, so leaving and re-entering the state restarts the invoke with the next candidate. Only when `pending` is empty does the machine leave for `checkingRepairBudget`.

`checkingRepairBudget` is a [choice state](machines.md#choice-states). It routes on `repairs < maxRepairs` and never waits, so the budget is a fact about the machine rather than a counter buried in a prompt. A choice state is transient, so it never appears in the transition log; only the states around it do.

`failed` is a real outcome with its own output, not a thrown error. A run that gives up still returns a `summary` explaining why.

## The validator as a host actor

The machine declares `parseConfig` as an ordinary actor and leaves it empty. The host supplies the real one:

```ts no-check
import { createAsyncLogic } from "xstate";

export const parseConfigActor = createAsyncLogic<GeneratedMachineConfig, { text: string }>({
  run: async ({ input }) => parseGeneratedConfig(input.text),
});

export const machine = agentMachine.provide({ actors: { parseConfig: parseConfigActor } });
```

The validator throws, with a message written for the model to read:

```ts no-check
throw new Error(
  `State "${stateName}" transitions on "${eventType}" to "${target}", which is not a declared state. ` +
    `Declared states: ${stateNames.join(", ")}.`,
);
```

That message is the repair request's whole input. A validator that throws `Invalid config` produces a repair round that guesses. Name the offending value and the legal set.

Keeping the validator behind `provide` means the machine artifact carries no database client, no file system, and no corpus. It stays serializable, testable, and portable between hosts.

## Fan-out and truncation

`generating` samples three drafts by invoking `generateConfig` three times. There is no `candidates` option on a request: fan-out is spelled out in the machine, so the concurrency, the join, and what a failed call costs are all visible in the state.

Fan-out and repairs solve different halves of the problem. The three calls run concurrently, so three drafts cost roughly one call's latency rather than three, and trying all three before spending a repair means an unlucky sample never costs a repair round.

A `finishReason` of `'length'` makes the adapter throw an [`AgentTruncatedError`](text-requests.md#finish-reason-and-truncation) for a structured request. With separate invokes, that failure lands on one slot: its `onError` marks the slot settled with no draft, and the other two carry on. Only when every slot failed is `pending` empty, and then there is no partial output to repair from, so the machine stops:

```ts no-check
onError: ({ context, event }) => ({
  context: {
    settled: context.settled + 1,
    failureReason:
      event.error.code === "truncated"
        ? "The model ran out of output tokens before finishing a config. Ask for a smaller machine, or raise maxOutputTokens."
        : `Generating a config failed: ${errorMessage(event.error)}`,
  },
}),
```

## Capping the loop

The machine's own cap is `checkingRepairBudget`. It is the one the app reasons about: `repairs` is in context, it is in the output, and a test asserts on it.

`maxModelCalls` is the second cap, and a different kind. It is the host's runaway backstop, it counts every model and decision call in the run, and the machine cannot read it. See [Usage and budgets](usage-and-budgets.md#the-global-backstop-maxmodelcalls).

```ts no-check
const result = await runAgent(machine, { input, executors, maxModelCalls: 10 });
```

With three author calls and `maxRepairs: 2`, a worst-case run makes five calls, so `result.usage.modelCalls` is `5`.

## Testing the loop without a key

The loop is worth testing precisely because the interesting paths are the ones a live run rarely takes. [`createScriptedExecutors`](evals.md#deterministic-whole-run-evals) supplies canned model output while the real validator runs, so every branch is a plain unit test.

```ts no-check
const scripted = createScriptedExecutors({
  text: {
    generateConfig: [BAD_JSON, NO_BLOCK, BAD_TARGET],
    repairConfig: [VALID],
  },
});

const result = await runAgent(machine, { input: { prompt: "a turnstile" }, executors: scripted });

expect(result.output.repairs).toBe(1);
expect(scripted.calls.map((call) => call.name)).toEqual([
  "generateConfig",
  "generateConfig",
  "generateConfig",
  "repairConfig",
]);
```

One queued answer per invoke: the fan-out makes three `generateConfig` calls, so the queue holds three drafts. Three cases cover the loop:

- **One candidate is valid.** The run finishes with `repairs === 0`, and no repair request was ever built.
- **All candidates are rejected, and the repair fixes it.** `repairs === 1`, and `matchesTrajectory` pins the path through `repairing` and back into `parsing`.
- **No repair ever parses.** The run ends in `failed` with `repairs === maxRepairs`, `config` is `null`, and `result.usage.modelCalls` is `3 + maxRepairs`, which is the assertion that the cap held.

`assertAgentMachine(machine)` covers the structure statically: a clean lint is the proof that `failed` is a target of some transition. [`canReach`](verify.md#reachability-checks) covers it dynamically. Exploration tracks every invoke a state is still waiting on, so it walks straight through the three-way fan-out, and a canned `parseConfig` failure drives the loop to the end of its repair budget.

```ts no-check
const canned = {
  input: { prompt: "a turnstile" },
  text: { generateConfig: VALID, repairConfig: VALID },
  invokes: { parseConfig: PARSED },
};

// The parser rejects every candidate and every repair: the budget runs out.
expect(
  (await canReach(machine, "failed", { ...canned, errors: { parseConfig: new Error("bad") } }))
    .reachable,
).toBe(true);
expect((await canReach(machine, "done", canned)).reachable).toBe(true);
```

## Evaluating the generate request live

Once the loop is pinned, the question that remains is whether a prompt change to the author request makes the parse succeed more often. That is one call in a chain, so score it with [`runSeam`](evals.md#seam-evals): every other request stays scripted, and the seam gets the real model.

```ts no-check
const { generateText } = createAiSdkExecutors({ models });

const run = await runSeam(machine, {
  input: { prompt: "a turnstile that locks and unlocks" },
  seam: { request: "generateConfig" },
  candidate: generateText,
  scripts: { repairConfig: [VALID] },
});

// The branch the live candidate caused: straight to `done`, or through `repairing`.
matchesTrajectory(run.after.statePath, ["parsing", "done"]).matched;
run.seamUsage?.totalTokens;
```

The score is the branch the seam caused, not a rubric over its text. A candidate prompt that reaches `done` without entering `repairing` is better by the only measure the app has, and `run.seamUsage` says what it cost.

## Related

- [examples/generate-and-repair](../examples/generate-and-repair/index.ts): the full machine, the validator, and the three scripted tests.
- [Text requests](text-requests.md): finish reasons and `AgentTruncatedError`.
- [Hosts and executors](hosts.md): the executor contract, and what a host owes a truncated call.
- [Testing and verification](verify.md): linting, scripted playthroughs, and reachability.
- [Evals](evals.md): seam runs and trajectory scoring.
- [Usage and budgets](usage-and-budgets.md): `maxModelCalls` and per-run token accounting.
