# Evals

Agent requests are independently executable, while the machine gives them meaningful state and trajectory context.

## Deterministic whole-run evals

```ts no-check
const scripted = createScriptedExecutors({
  text: {
    evaluatePrompt: [{ output: assessment }],
    draftEmail: [{ output: draft }]
  },
  decisions: {
    chooseRoute: [{ type: "DRAFT" }]
  }
});

const transitions = [];
const result = await runAgent(machine, {
  input,
  executors: scripted,
  onTransition: (snapshot, event) => {
    transitions.push({ value: snapshot.value, event });
  }
});
```

`scripted.calls` records ordered request names, kinds, inputs, and request envelopes.

### Script keys

Scripts route by semantic request `name`, not prompt text. A request's name is the first of these that exists:

1. its `name`: the `setupAgent({ requests })` key, the `createTextLogic`/`createDecisionLogic` `name`, or the `name` field on an inline `agent.decide` input;
2. the invoke `id`;
3. the invoke's state path, such as `0.(machine).guessing`.

Name the request rather than relying on 2 or 3. A named request fails loudly when it is renamed or reordered, instead of silently taking another request's answer, and a state path changes whenever the machine is restructured.

```ts no-check
guessing: {
  invoke: {
    src: "agent.decide",
    input: ({ context }) => ({
      model: "fast",
      name: "guessLetter",
      allowedEvents: ["GUESS", "QUIT"],
    }),
  },
}
```

```ts no-check
createScriptedExecutors({
  decisions: { guessLetter: [{ type: "GUESS", letter: "e" }] }
});
```

Use `"*"` as a fallback route, and a flat array only when the machine makes one kind of request.

> **Note:** `simulateAgent` and `explorePaths` are a different API with a different script: they key by invoke **src**, not by request name. See [Verification](verify.md#scripted-playthroughs).

### Entry shapes

A `text` entry is the request's **output value**: a bare string for a text request, or the object a structured request declares.

```ts no-check
text: {
  answer: ["Because transitions constrain behavior."],
  assess: [{ score: 4, notes: "clear" }]
}
```

An entry is read as the executor envelope instead only when its own keys are `output` plus, optionally, `usage` and `raw`. That is how an entry reports token usage, and it is why `{ output: assessment }` and `assessment` mean the same thing for any `assessment` that has no `output` key of its own. A structured request whose declared output is itself `{ output }` needs one more wrap: `{ output: { output: "…" } }`.

An entry may also be a function of the request, which is how one script serves a machine that loops or branches: `text: { answer: [(request) => "Draft about " + request.prompt] }`.

A `decisions` entry is the chosen event (`{ type: "GUESS", letter: "e" }`), or `{ event, reason?, usage? }` when it reports a reason or usage.

### Repeating and exhausting

Each key holds a FIFO queue, consumed once per matching call and shared across every `runAgent` call that takes the same executor set. Exhaustion is the default and it is what makes a call count exact: a queue that runs dry throws instead of quietly reusing an answer.

A looping machine takes `repeat: true`, which reuses the last routed entry after its queue is exhausted:

```ts no-check
createScriptedExecutors({ text: { revise: [draft] }, repeat: true });
```

Build the executors once per run. A script queue is stateful, so an executor set hoisted across runs replays a partly consumed script into the next one.

### Script faults are not model failures

An unknown key and a dry queue both throw `AgentScriptedExecutorError` (codes `scripted-executors-unknown-name` and `scripted-executors-exhausted`) from inside the executor, so an invoke that declares `onError` routes it like any model failure and the run settles with a plausible-looking outcome. Two things keep that honest:

- the executor set is poisoned after the first fault, so no later call is served (pass `strict: false` for the legacy per-call behavior);
- `scripted.assertScriptOk()` rethrows the fault. Call it after every scripted run.

```ts no-check
const result = await runAgent(machine, { input, executors: scripted });
scripted.assertScriptOk();
```

## Individual request evals

Use `executeAgentRequest` with a request and executor when the eval targets one LLM call. Requests carry their semantic `name` and resolved `input`, so datasets need no prompt sniffing.

## Seam evals

`runSeam` replaces one named request occurrence with a candidate executor while keeping the rest scripted. Score its `seamOutput`, calls, state path, and XState transition events.

## Verification

`simulateAgent`, `explorePaths`, `canReach`, and `matchesTrajectory` operate on the machine artifact. Unknown state targets and empty expected trajectories fail loudly instead of producing misleading successful scores.
