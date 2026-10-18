---
name: generate-machine
description: Author a @statelyai/agent workflow as JSON and check it before it runs. Use when asked to generate or author an agent machine, create a workflow config, write an AgentWorkflowConfig, or produce an LLM-authored state machine for an agent — and when a generated config fails verifyAgentConfig, Ajv validation, or agent lint and needs repair.
---

# Generate an agent machine

An agent machine is data. You author a JSON `AgentWorkflowConfig`, then run it through `verifyAgentConfig`, whose gates all work with no API key: validate → vocabulary → lower → lint → explore. Do not hand back a config that has not passed every gate.

```
split environment/policy → author (description = goal) → verifyAgentConfig → repair (≤ 3) → persist traces → hand back
```

To improve an existing policy from its traces, use the `improve-machine` skill instead.

## 0. Split environment and policy

Decide what is fixed before you write any JSON.

- **Environment** (TypeScript, fixed): the rules of the world and the business invariants, as states and guards. People author it and verify it with `canReach` / `explorePaths` from `@statelyai/agent/testing`. You never generate it, and no generated config may change it.
- **Policy** (JSON, generated): how the agent works toward the goal: which step next, which tool, when to ask a person, cheap judgment vs model call. This is the `AgentWorkflowConfig` you author.
- The policy plugs into the environment at its decision points and outputs one event; the environment's guards decide whether to accept it.
- No split needed for a single judgment inside a fixed workflow, or for a workflow where every step is dictated by rules. Author one machine.

If the request asks you to generate a business rule (an approval threshold, a payout limit), stop: that belongs in the environment, in TypeScript, reviewed by a person. Say so.

Before editing an existing machine, read it as text:

```ts
import { describeMachine } from "@statelyai/agent";
const text = describeMachine(machine); // "Machine <id>", then "Goal: …", states, transitions, events
```

Pass `{ snapshot }` to mark the active states with `*`. Concept page: `docs/environment-and-policy.md`.

## 1. Read the schema

The config shape is fixed by a shipped JSON Schema. Read it first; it is the contract.

- Consuming the package: `node_modules/@statelyai/agent/agent-workflow.json` (importable as `@statelyai/agent/agent-workflow.json`)
- In the `statelyai/agent` repo: `schemas/agent-workflow.json`

## 2. Author the config

Start with the root `description`: it is the machine's **goal**, the overall objective plus measurable success criteria. `describeMachine` renders it first as `Goal: …`, and an improver later climbs toward it. Write criteria a scorer can compute from outcomes (terminal states, effects in the world, cost), not "be helpful":

```json
"description": "Resolve each support ticket in one session. Success: escalations only for tickets that need a human; every reply approved before sending; at most 2 model calls per ticket."
```

Rules the runtime enforces. Each one maps to a build error or a lint diagnostic:

- Every value is a JSON literal or a whole-string `"{{ }}"` expression reading a dot path on `input`, `context`, or `event`. No JavaScript.
- Guard expressions are truthy-only: no comparisons, operators, or negation.
- A model call is either a named `requests` entry invoked with `src: "<requestName>"`, or an inline invoke with `src: "agent.decide"` plus an `allowedEvents` list.
- A state invoking `agent.decide` MUST handle every allowed event in its `on`.
- An `agent.decide` invoke has no `onDone` (a decision produces no output). Use `onError` for the retries-exhausted path.
- A request invoke resolves with `{ result, messages }`, so `onDone.assign` reads its result from `"{{ event.output.result.<field> }}"` (`"{{ event.output.result }}"` for a plain-text request). A non-request `actors` invoke reads `"{{ event.output.<field> }}"` directly.
- Every path must reach a `"type": "final"` state, and each final state needs an `output` when `schemas.output` is declared.
- Do not invent guard or action names. Only `"{{ }}"` guards, `assign`, and `emit` exist unless the host tells you which named guards/actions it implements.
- Model refs are strings (`"openai/gpt-5.4-mini"`); the host resolves them.
- To make a decision a closed choice, add `payloads` to the `agent.decide` input: one payload list per event type, without `type` (`"payloads": { "REFUND": [{ "amount": 20 }, { "amount": 50 }], "ESCALATE": [] }`). The model then picks one listed event instead of writing a payload. A type with no key is offered as `{ type }`; `[]` withholds it.
- An idle human step can carry `meta.interaction` for the host to render with `getInteraction`: a `label`, `events` (one button per event type), `choices` (one button per full event, `{ "label": "Refund $20", "event": { "type": "REFUND", "amount": 20 } }`), `choicesFrom` (a context path holding such a list), and `textEvent` for free text. A bare `"textEvent": "REJECT"` puts the text in a `text` field; `{ "type": "REJECT", "field": "reason" }` names the field. `meta` is not template-evaluated.

Reference config — decision, text request, idle human step, one final state:

```json
{
  "id": "support-ticket",
  "description": "Resolve each support ticket in one session. Success: escalations only for tickets that need a human; every reply approved before sending; at most 2 model calls per ticket.",
  "schemas": {
    "input": {
      "type": "object",
      "properties": { "ticket": { "type": "string" } },
      "required": ["ticket"]
    },
    "context": {
      "type": "object",
      "properties": {
        "ticket": { "type": "string" },
        "reply": { "type": "string" },
        "resolution": { "type": "string" }
      },
      "required": ["ticket"]
    },
    "events": {
      "ESCALATE": {
        "type": "object",
        "properties": { "reason": { "type": "string" } },
        "required": ["reason"]
      },
      "REPLY": { "type": "object", "properties": {} },
      "APPROVE": { "type": "object", "properties": {} },
      "REJECT": { "type": "object", "properties": {} }
    },
    "output": {
      "type": "object",
      "properties": { "resolution": { "type": "string" }, "reply": { "type": "string" } },
      "required": ["resolution"]
    }
  },
  "context": { "ticket": "{{ input.ticket }}" },
  "requests": {
    "draftReply": {
      "model": "openai/gpt-5.4-mini",
      "system": "Draft a short, courteous support reply.",
      "prompt": "{{ context.ticket }}",
      "input": {
        "type": "object",
        "properties": { "ticket": { "type": "string" } },
        "required": ["ticket"]
      },
      "output": {
        "type": "object",
        "properties": { "reply": { "type": "string" } },
        "required": ["reply"]
      }
    }
  },
  "initial": "triaging",
  "states": {
    "triaging": {
      "invoke": {
        "id": "triageDecision",
        "src": "agent.decide",
        "input": {
          "model": "openai/gpt-5.4-mini",
          "system": "Decide whether this ticket needs escalation or a drafted reply.",
          "prompt": "{{ context.ticket }}",
          "allowedEvents": ["ESCALATE", "REPLY"],
          "maxRetries": 2
        },
        "onError": { "target": "resolved", "assign": { "resolution": "escalated" } }
      },
      "on": {
        "ESCALATE": { "target": "resolved", "assign": { "resolution": "escalated" } },
        "REPLY": { "target": "drafting" }
      }
    },
    "drafting": {
      "invoke": {
        "id": "draft",
        "src": "draftReply",
        "input": { "ticket": "{{ context.ticket }}" },
        "onDone": {
          "target": "awaitingApproval",
          "assign": { "reply": "{{ event.output.result.reply }}" }
        }
      }
    },
    "awaitingApproval": {
      "description": "Idle: nothing to do until a human approves or rejects the draft.",
      "on": {
        "APPROVE": { "target": "resolved", "assign": { "resolution": "replied" } },
        "REJECT": { "target": "resolved", "assign": { "resolution": "escalated" } }
      }
    },
    "resolved": {
      "type": "final",
      "output": { "resolution": "{{ context.resolution }}", "reply": "{{ context.reply }}" }
    }
  }
}
```

## 3. Verify with `verifyAgentConfig`

`verifyAgentConfig(config, options)` from `@statelyai/agent/validate` runs every pre-run gate and stops at the first failure. It never throws on a bad config; each gate is a record `{ name, ok, detail? }`. It needs `ajv` installed (an optional peer of the package).

| Gate         | Checks with                            | Fails on                                                                                                                                                   |
| ------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`   | `validateAgentConfig` (shipped schema) | malformed config shape                                                                                                                                     |
| `vocabulary` | `allow` lists                          | an invoke src, named guard, named action, `agent.decide` event, or model ref not listed                                                                    |
| `lower`      | `setupAgent.fromConfig`                | unresolved named guard/action, `onDone` on an `agent.decide` invoke                                                                                        |
| `lint`       | `lintAgentMachine`                     | error findings (warnings too with `lint: { warnings: true }`)                                                                                              |
| `explore`    | `explorePaths`, once per input         | a path ending outside `explore.terminals` (default `['done']`), a loop past `maxDepth`, a `maxPaths`/`maxNodes` cap, untried payloads (`unexpandedEvents`) |

`compileSchema` turns the JSON Schemas _inside_ the config into Standard Schema validators for `fromConfig`. The library bundles no JSON Schema engine:

```ts
import Ajv from "ajv";
import type { SchemaCompiler, StandardSchemaV1 } from "@statelyai/agent";

const ajv = new Ajv({ strict: false });

export const compileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
  const validate = ajv.compile(jsonSchema);
  return {
    "~standard": {
      version: 1,
      vendor: "ajv",
      validate: (value) =>
        validate(value)
          ? { value }
          : {
              issues: (validate.errors ?? []).map((e) => ({
                message: `${name}${e.instancePath} ${e.message}`,
              })),
            },
      // Expose the source JSON Schema so lint and describeMachine can read the shape.
      jsonSchema: { input: () => jsonSchema },
    },
  };
};
```

Run the gates. List the host's real names in `allow`; an omitted key is unrestricted:

```ts
import { verifyAgentConfig } from "@statelyai/agent/validate";

const result = await verifyAgentConfig(candidate, {
  compileSchema,
  allow: {
    actors: [],
    requests: ["draftReply"],
    guards: [],
    actions: [],
    events: ["ESCALATE", "REPLY", "APPROVE", "REJECT"],
    models: ["openai/gpt-5.4-mini"],
  },
  explore: {
    inputs: [{ ticket: "Export downloads a 0-byte CSV on Safari." }],
    text: { draftReply: { reply: "" } },
  },
});
// result.ok, result.gates, result.config (after validate), result.machine (after lower)
```

- Exploration forks past idle waits on every event the waiting state accepts, so a human step still ends `done`. Add `terminals: ["done", "idle"]` only when a path may legitimately stop at a wait with nothing to accept.
- `guards` / `actions`: named implementations, passed to `fromConfig`. `actors`: bound with `machine.provide({ actors })` after lowering.
- `explore` keys other than `inputs` and `terminals` pass through to `explorePaths`: `text` (canned request outputs), `invokes` (canned actor outputs), `errors` (fork a rejected branch per src), `outputs` (fork one branch per listed output), `payloads` (fork one branch per payload at decisions and idle waits), `dedupeBy` (explore each snapshot key once; the key must cover every field a guard reads), `maxDepth` (default 8), `maxPaths` (default 200), `maxNodes` (default 100,000).
- Stub each request's output from its declared `output` schema (`""` for string, `0` for number, `[]` for array, recurse on `properties`). Add an `errors` entry for every src whose `onError` path matters.
- Pick `explore.inputs` that reach every branch the goal cares about. Exploration covers only the inputs you give it.
- A passing `lint` gate carries its warnings in `detail`. Report them.

## 4. Repair loop

A failed gate's `detail` names the offending path, state, or name, one problem per line. Feed it back verbatim with the rejected config, and run the gates again:

```ts
let prompt = originalTask;
for (let attempt = 0; attempt < 3; attempt++) {
  const candidate = await author({ system, prompt });
  const result = await verifyAgentConfig(candidate, verifyOptions);
  if (result.ok) return result;
  const failed = result.gates.find((gate) => !gate.ok)!;
  prompt = `${originalTask}\n\nYour previous config:\n${JSON.stringify(candidate)}\n\nGate '${failed.name}' failed:\n${failed.detail}\nReturn a corrected config.`;
}
```

Keep the cap at 3. A config that fails three repairs is usually asking for something the data form cannot express: author it in TypeScript with `setupAgent` instead, or report that the vocabulary is missing something.

## 5. Manual fallback

Without `verifyAgentConfig` (older package, or a gate you need to run alone), run the same gates by hand:

```ts
import { setupAgent, type AgentWorkflowConfig } from "@statelyai/agent";
import { validateAgentConfig } from "@statelyai/agent/validate";
import { explorePaths, lintAgentMachine, simulateAgent } from "@statelyai/agent/testing";

const validation = validateAgentConfig(candidate); // { valid, errors: [{ path, message }] }, path is a JSON Pointer
if (!validation.valid) {
  // Stop here: feed the errors back as the repair prompt. Never lower an invalid config.
  throw new Error(validation.errors.map((e) => `${e.path} ${e.message}`).join("\n"));
}
const { machine } = setupAgent.fromConfig(candidate as AgentWorkflowConfig, { compileSchema }); // throws on unresolved names
lintAgentMachine(machine, { throw: true }); // throws AgentLintError on error findings
const dryRun = await simulateAgent(machine, {
  input: { ticket: "" },
  script: {
    decisions: { "agent.decide": [{ type: "REPLY" }] },
    text: { draftReply: [{ reply: "" }] },
  },
}); // dryRun.status: 'done' | 'idle' | 'exhausted' ('exhausted' = loops, reject)
const report = await explorePaths(machine, {
  input: { ticket: "" },
  text: { draftReply: { reply: "" } },
});
```

The lint check that bites most often is `decide-without-events`: an `allowedEvents` list with no matching `on` transitions. Do not disable checks.

## 6. Persist traces from day one

An improver needs data. Wire an event log store and a thread id per run before the first real run, so every run is a trace:

```ts
import { runAgent } from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";

const store = createInMemoryEventLogStore(); // tests only; implement AgentEventLogStore on your database
const result = await runAgent(machine, {
  input,
  executors,
  store,
  threadId: `tickets:${ticketId}`,
});
```

- `threadId` is required with `store`. One thread per run.
- Give thread ids a prefix an improver can list by, such as `tickets:<ticketId>`. `store.listThreads({ prefix, limit, cursor })` pages through them. It is optional on a custom `AgentEventLogStore`, so with a store that lacks it, record each thread id with its scenario or ticket.
- Failed decision attempts are journaled on the entry they explain; `getDecisionAttempts(entries)` from `@statelyai/agent/log` reads them back.
- `replay(machine, await store.read(threadId))` from `@statelyai/agent/log` rebuilds the final state with no model calls. Pass the machine that recorded the thread: with an environment and a policy, the environment; `getUsageFromEvents(entries)` sums token usage.

## 7. Hand back

Deliver the config JSON plus how to run it:

```ts
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const run = await runAgent(result.machine!, {
  input: { ticket: "Export downloads a 0-byte CSV on Safari." },
  executors: createAiSdkExecutors({ resolveModel }),
  store,
  threadId,
});
```

Say which gates passed (list `result.gates`), list any lint warnings, state the goal and its success criteria, and say where traces are written. Model refs are strings, so the host supplies `resolveModel`.

## Known limits

- **Named guards and actions are host-resolved.** A config carries no functions. `guard: "isReady"` only works if the host passes an `isReady` implementation to `fromConfig`; an unresolved name is a build-time throw. Either list the host's names in the prompt or forbid named guards/actions entirely.
- **Expressions are dot-path templates only.** `"{{ context.a.b }}"` — no comparisons, no arithmetic, no method calls, no partial interpolation inside a larger string.
- **Ajv validity is not semantic validity.** A config can validate and still invoke a request that does not exist or route to a state that solves nothing. That is what the `vocabulary`, `lint`, and `explore` gates are for.
- **Exploration covers the inputs you give it.** A branch no `explore.inputs` entry reaches is unverified.
- **Model refs are checked only with `allow.models`.** Tool names stay unchecked strings that resolve at run time, in the host.
- **The gates check structure, not quality.** Whether a config is better than another is measured by replaying scenarios against an objective. See the `improve-machine` skill.
