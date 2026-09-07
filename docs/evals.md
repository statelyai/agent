# Evals

Agent requests are independently executable, while the machine gives them meaningful state and trajectory context.

## Deterministic whole-run evals

Any function satisfies an executor slot, so a one-off stand-in needs no helper:

```ts no-check
executors: { generateText: async () => ({ output: "a draft" }) }
```

## Scripted executors

`createScriptedExecutors` is the multi-request version: ordered answers by request name, where the last entry for a name repeats forever.

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

Scripts route by semantic request `name`, not prompt text. A request resolves its name before routing, taking the first of these that exists:

1. its `name`: the `setupAgent({ requests })` key, the `createTextLogic`/`createDecisionLogic` `name`, or the `name` field on an inline `agent.decide` input;
2. the invoke `id`.

`"*"` is the fallback route for anything unmatched. Name the request rather than relying on 2: a named request fails loudly when it is renamed or reordered, instead of silently taking another request's answer.

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

Use `"*"` as a fallback route for anything unmatched.

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

### Order and repetition

Entries for a name are consumed in order, and the last one repeats forever, so a looping machine needs no extra option:

```ts no-check
createScriptedExecutors({ text: { revise: [firstDraft, revisedDraft] } });
```

Assert exact call counts through `scripted.calls` rather than through exhaustion.

Build the executors once per run. The position within each list is stateful, so an executor set hoisted across runs starts partway through its script.

A request the script has no route for throws a plain `Error` naming the known keys. It reaches the machine as an ordinary actor error, so an invoke that declares `onError` routes it like a model failure — check `scripted.calls` when a run settles suspiciously.

## Individual request evals

Use `executeAgentRequest` with a request and executor when the eval targets one LLM call. Requests carry their semantic `name` and resolved `input`, so datasets need no prompt sniffing.

## Seam evals

`runSeam` replaces one named request occurrence with a candidate executor while keeping the rest scripted. Score its `seamOutput`, calls, state path, and XState transition events.

## Verification

`simulateAgent`, `explorePaths`, `canReach`, and `matchesTrajectory` operate on the machine artifact. Unknown state targets and empty expected trajectories fail loudly instead of producing misleading successful scores.
