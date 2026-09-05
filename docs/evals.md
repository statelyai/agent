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

Scripts route by semantic request `name`, not prompt text. `scripted.calls` records ordered request names, kinds, inputs, and request envelopes.

## Individual request evals

Use `executeAgentRequest` with a request and executor when the eval targets one LLM call. Requests carry their semantic `name` and resolved `input`, so datasets need no prompt sniffing.

## Seam evals

`runSeam` replaces one named request occurrence with a candidate executor while keeping the rest scripted. Score its `seamOutput`, calls, state path, and XState transition events.

## Verification

`simulateAgent`, `explorePaths`, `canReach`, and `matchesTrajectory` operate on the machine artifact. Unknown state targets and empty expected trajectories fail loudly instead of producing misleading successful scores.
