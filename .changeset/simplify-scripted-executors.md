---
"@statelyai/agent": minor
---

`createScriptedExecutors` is now one rule: answers keyed by request name, consumed in order, with the last entry for a name repeating forever.

```ts
createScriptedExecutors({
  text: { draft: ["first pass", "revised"] },
  decisions: { route: [{ type: "PUBLISH" }] },
});
```

Removed: `repeat`, `strict`, positional (un-named) arrays, `scripted.scriptError`, `scripted.assertScriptOk()`, and the exported `AgentScriptedExecutorError`. A request the script has no route for throws a plain `Error("No scripted answer for request 'x'. Known: a, b")` from inside the executor, which reaches the machine as an ordinary actor error. `scripted.calls` still records every call, so assert exact call counts through it.

`"*"` remains the fallback key, and `userInput` remains a flat array.

Docs: the quickstart's first run is a three-line inline executor (`executors: { generateText: async () => ({ output: "…" }) }`) with no helper import; `createScriptedExecutors` is documented in `evals.md`, and `models-and-providers.md` shows the AI SDK's own `MockLanguageModelV3` from `ai/test` for testing the adapter path.
