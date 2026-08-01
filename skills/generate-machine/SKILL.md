---
name: generate-machine
description: Author a @statelyai/agent workflow as JSON and check it before it runs. Use when asked to generate or author an agent machine, create a workflow config, write an AgentWorkflowConfig, or produce an LLM-authored state machine for an agent — and when a generated config fails Ajv validation or agent lint and needs repair.
---

# Generate an agent machine

An agent machine is data. You author a JSON `AgentWorkflowConfig`, then run it through gates that all work with no API key: Ajv → `fromConfig` → lint → simulate. Do not hand back a config that has not passed all four.

```
author → validate (Ajv 2020) → lower (fromConfig) → lint (assertAgentMachine) → simulate → hand back
```

## 1. Read the schema

The config shape is fixed by a shipped JSON Schema. Read it first; it is the contract.

- Consuming the package: `node_modules/@statelyai/agent/agent-workflow.json` (importable as `@statelyai/agent/agent-workflow.json`)
- In the `statelyai/agent` repo: `schemas/agent-workflow.json`

## 2. Author the config

Rules the runtime enforces. Each one maps to a build error or a lint diagnostic:

- Every value is a JSON literal or a whole-string `"{{ }}"` expression reading a dot path on `input`, `context`, or `event`. No JavaScript.
- Guard expressions are truthy-only: no comparisons, operators, or negation.
- A model call is either a named `requests` entry invoked with `src: "<requestName>"`, or an inline invoke with `src: "agent.decide"` plus an `allowedEvents` list.
- A state invoking `agent.decide` MUST handle every allowed event in its `on`.
- An `agent.decide` invoke has no `onDone` (a decision produces no output). Use `onError` for the retries-exhausted path.
- A request invoke reads its result via `onDone.assign` from `"{{ event.output.<field> }}"`.
- Every path must reach a `"type": "final"` state, and each final state needs an `output` when `schemas.output` is declared.
- Do not invent guard or action names. Only `"{{ }}"` guards, `assign`, and `emit` exist unless the host tells you which named guards/actions it implements.
- Model refs are strings (`"openai/gpt-5.4-mini"`); the host resolves them.

Reference config — decision, text request, idle human step, one final state:

```json
{
  "id": "support-ticket",
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
          "assign": { "reply": "{{ event.output.reply }}" }
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

## 3. Validate with Ajv 2020

The workflow schema is draft 2020-12, so it needs Ajv's 2020 build. Run this before anything else touches the config.

```ts
import Ajv2020 from "ajv/dist/2020.js";
import workflowSchema from "@statelyai/agent/agent-workflow.json";
import type { AgentWorkflowConfig } from "@statelyai/agent";

const validateWorkflow = new Ajv2020({ strict: false }).compile(workflowSchema);

function validateGeneratedConfig(candidate: unknown): AgentWorkflowConfig {
  if (validateWorkflow(candidate)) return candidate as AgentWorkflowConfig;
  throw new Error(
    (validateWorkflow.errors ?? [])
      .map((error) => `${error.instancePath || "(root)"} ${error.message}`)
      .join("\n"),
  );
}
```

Ajv errors carry `instancePath`, so a repair prompt can name the exact bad field.

## 4. Lower with `fromConfig`

`fromConfig` needs a `compileSchema` that turns the JSON Schemas _inside_ the config into Standard Schema validators. Two engines, two jobs: the 2020 build above checks the config document; this one compiles the per-field schemas. The library bundles no JSON Schema engine, by design.

```ts
import Ajv from "ajv";
import { setupAgent, type SchemaCompiler, type StandardSchemaV1 } from "@statelyai/agent";

const ajv = new Ajv({ strict: false });

export const ajvCompileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
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
      // Expose the source JSON Schema so lint's serializability checks can read the shape.
      jsonSchema: { input: () => jsonSchema },
    },
  };
};

const { machine, schemas } = setupAgent.fromConfig(config, { compileSchema: ajvCompileSchema });
```

Lowering is itself a gate: it throws on an unresolved named guard/action and on an `onDone` attached to an `agent.decide` invoke.

## 5. Lint

```ts
import { assertAgentMachine, lintAgentMachine } from "@statelyai/agent";

const diagnostics = lintAgentMachine(machine);
assertAgentMachine(machine); // throws AgentLintError on error-severity findings
```

Every check applies to config-built machines, reachability included — the lowering keeps the config's transition targets, so `unreachable-state` and `missing-final` read the real graph. Do not disable checks.

The one that bites most often is `decide-without-events`: an `allowedEvents` list with no matching `on` transitions produces a decision the machine can never deliver.

## 6. Simulate a dry run

Lint is structural. A dry run proves a path actually settles. No API key needed.

```ts
import { simulateAgent } from "@statelyai/agent";

const dryRun = await simulateAgent(machine, {
  input: { ticket: "" },
  script: {
    decisions: { "agent.decide": [{ type: "REPLY" }] },
    text: { draftReply: [{ reply: "" }] },
  },
});
// dryRun.status: 'done' | 'idle' | 'exhausted'
```

Derive the script from the config rather than guessing: take the first entry of each decision's `allowedEvents`, and stub each request's output from its declared `output` schema (`""` for string, `0` for number, `[]` for array, recurse on `properties`).

- `'exhausted'` → the machine loops. Reject it.
- `'idle'` → it stopped at a human step. Expected when the config has one.
- To cover every branch instead of one path, use `explorePaths` / `canReach`.

## 7. Repair loop

Every gate throws with a message naming the offending field, state, or path. Feed that message back verbatim and regenerate:

```ts
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    return buildAndVet(await author({ system, prompt }));
  } catch (error) {
    prompt = `${originalTask}\n\nYour previous config was rejected:\n${(error as Error).message}\nReturn a corrected config.`;
  }
}
```

Keep the cap at ~3. A config that fails three schema-shaped repairs is usually asking for something the data form cannot express — author it in TypeScript with `setupAgent` instead.

## 8. Hand back

Deliver the config JSON plus how to run it:

```ts
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const result = await runAgent(machine, {
  input: { ticket: "Export downloads a 0-byte CSV on Safari." },
  executors: createAiSdkExecutors({ resolveModel }),
});
```

Say which gates passed, list any warning-severity lint diagnostics, and report the dry-run status. Model refs are strings, so the host supplies `resolveModel`.

## Known limits

- **Named guards and actions are host-resolved.** A config carries no functions. `guard: "isReady"` only works if the host passes an `isReady` implementation to `fromConfig`; an unresolved name is a build-time throw. Either list the host's names in the prompt or forbid named guards/actions entirely.
- **Expressions are dot-path templates only.** `"{{ context.a.b }}"` — no comparisons, no arithmetic, no method calls, no partial interpolation inside a larger string.
- **Ajv validity is not semantic validity.** A config can validate and still invoke a request that does not exist or route to a state that solves nothing. That is what lint and simulate are for.
- **A dry run covers one path.** Use `explorePaths` when the branch structure matters.
- **Model refs and tool names are unchecked strings.** They resolve at run time, in the host.
