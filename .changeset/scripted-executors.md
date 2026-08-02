---
"@statelyai/agent": minor
---

**`createScriptedExecutors`: run any agent machine with no API key.** A keyless, dependency-free executor set (root export) that plays back a script instead of calling a model, so `runAgent` / `provideExecutors` work end to end with nothing installed but core. The quickstart's first run is now keyless.

```ts
const result = await runAgent(moderationMachine, {
  input: { comment: "honestly this update is terrible", trust: 20 },
  executors: createScriptedExecutors({
    // Plain values play back FIFO. An entry can also be a function of the
    // request, which says where it was called from: `request.id` is the invoke
    // id, `request.events` the state's legal candidates, `request.name` the
    // text request's name.
    decisions: [(request) => ({ type: request.events[0]!.type })],
    text: ["a scripted draft"],
  }),
});
```

- Supplies all three slots (`generateText`, `streamText`, `decide`). `decisions` answers decisions and `agent.plan`; `text` answers text requests, with `generateText` and `streamText` sharing one FIFO queue.
- Entries are plain values or functions of the request, so one script serves a branching or looping machine: route on `request.name`, on a decision's candidate `events`, or on its prior failed `attempts`.
- An entry may be the raw executor envelope (`{ output, usage }` / `{ event, reason, usage }`), so scripted runs exercise usage aggregation too. A text entry counts as the envelope only when its own keys are `output` plus optionally `usage` / `raw`; an object owning any other key (`{ output: 'draft', confidence: 0.9 }`) is the output value, siblings intact. For a structured request whose output really is `{ output }`, wrap it once more: `{ output: { output: '…' } }`.
- A dry queue throws a descriptive error naming the pending request (and, for decisions, the candidate events). Queues are copied on creation, so one script object seeds many independent runs.

New exported types: `ScriptedExecutorsScript`, `ScriptedDecisionEntry`, `ScriptedDecisionValue`, `ScriptedTextEntry`.
