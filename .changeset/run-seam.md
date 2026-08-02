---
"@statelyai/agent": minor
---

**`runSeam`: seam evals as one root export.** It runs a machine end to end with every model call scripted except one, and returns that call's answer plus the trajectory slices around it — the recipe that previously took ~200 lines of routing, driving and slicing in every eval.

```ts
const run = await runSeam(emailDrafter, {
  scripts: { promptEvaluator: [vague, complete], emailDrafter: [draft] },
  seam: { request: "evaluatePrompt" }, // or { model: 'promptEvaluator', occurrence: 0 }
  candidate: createAiSdkExecutors({ models }).generateText, // omit for a keyless run
  respond: ({ state }) =>
    state === "prompting" ? { type: "PROMPT_SUBMITTED", prompt } : { type: "SEND" },
});

matchesTrajectory(run.after.statePath, ["needsMoreInfo", "drafting"]);
matchesTrajectory(run.after.events, ["MORE_INFO", "SEND", "END"]);
```

- The seam is addressed by request `name` or by `model` key, plus a 0-based `occurrence`, so "the second `draftEmail` call" is a value. A `scripts` key is a request `name` when one is scripted under it, else a `model` key.
- `scripts` follows `createScriptedExecutors` entry conventions (values, `{ output, usage }` envelopes, functions of the request). Each queue's last entry repeats, so a live seam that branches down a longer path never runs dry.
- `respond` is the reactive simulated user, called at every idle pause with `{ snapshot, state, meta, turn, result }`. Supply `executors` for a machine that also decides; text slots are always owned by the routing.
- `candidate` is just an executor, so a live model, a candidate prompt or a fine-tune all plug in; without one the whole run is keyless.
- The result is `{ result, seamOutput, callsBeforeSeam, before, after }`, where `before` / `after` are `{ statePath, events }` pairs ready for `matchesTrajectory`. The split is the seam's own effect completion, so `after` is exactly the branch the seam caused. Note `result.events` covers the whole run while `result.usage` accounts only for the last leg.
