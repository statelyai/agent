---
"@statelyai/agent": minor
---

**`verifyAgentConfig`.** `@statelyai/agent/validate` adds one call that runs every pre-run gate on a model-authored `AgentWorkflowConfig` and stops at the first failure: `validate` (shipped JSON Schema), `vocabulary` (the actors, requests, named guards, actions, decision events, and model refs in `allow`), `lower` (`setupAgent.fromConfig`), `lint` (`lintAgentMachine`), and `explore` (`explorePaths` per `explore.inputs` entry, every path ending in `explore.terminals`). With `allow` given, a raw `{ "@expr": ... }` slot anywhere in the config fails `vocabulary`, since xstate would evaluate it in place of the literals the lists check. `explore` also fails on an empty `explore.inputs`, on a `maxPaths` or `maxNodes` cap that cut exploration short, and on `unexpandedEvents` (event types whose payloads were not all tried; add `payloads` entries). Other `explore` keys pass through to `explorePaths`; script text requests and invoked actors with `outputs`, not `text` or `invokes`, as for `explorePaths` (see the breaking note there). It never throws on a bad config. Each gate is `{ name, ok, detail? }`, and `detail` is a model-readable repair prompt.

```ts
import { verifyAgentConfig } from "@statelyai/agent/validate";

const result = await verifyAgentConfig(candidate, {
  compileSchema,
  allow: { requests: ["draftReply"], events: ["APPROVE", "DENY"], models: ["openai/gpt-5.4-mini"] },
  explore: { inputs: [{ amount: 5 }, { amount: 500 }], outputs: { draftReply: [{ reply: "" }] } },
});
const failed = result.gates.find((gate) => !gate.ok);
if (failed) feedback.push(`gate '${failed.name}' failed: ${failed.detail}`);
```
