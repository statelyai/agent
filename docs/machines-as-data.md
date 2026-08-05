---
title: Machines as data
description: Author an agent machine as a JSON or YAML config and lower it into the same runnable XState machine that setupAgent builds in TypeScript.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

<!-- setupAgent.fromConfig lowering from src/workflow-config.ts -->

An agent machine can be pure data. Describe it as a JSON or YAML config and hand it to `setupAgent.fromConfig(...)` (same import as `setupAgent`). It produces the same runnable XState machine `setupAgent(...)` builds by hand: states, choice routing, guard-expression transitions, emitted progress events, text requests, decisions, and idle steps. Only the authoring format changes.

```ts
import { setupAgent } from "@statelyai/agent";

const { machine, schemas } = setupAgent.fromConfig(config, {
  compileSchema: ajvCompileSchema,
});
```

> **Bring your own `compileSchema`.** The library bundles no JSON Schema engine, so `fromConfig(...)` will not run without a `compileSchema` you supply (Ajv, `@cfworker/json-schema`, or anything returning Standard Schema). See [Schema compilation](#schema-compilation).

`fromConfig(...)` returns two things:

- `machine`: the runnable XState machine, ready for `runAgent(...)`.
- `schemas`: the compiled `AgentSchemaPack` (`context`, `events`, `emitted`, `input`, `output`, `meta` as Standard Schema validators), for host-side validation and tooling.

A config is portable: generate it from a model, store it in a database row, or edit it in a visual builder, and it runs exactly like a hand-authored [machine](machines.md).

## Validating a config

<!-- schema export path from package.json exports and schemas/agent-workflow.json -->

The package ships a JSON Schema for validating and editing configs:

```ts
import workflowSchema from "@statelyai/agent/agent-workflow.json";
```

Point an editor, form generator, or validation step at it to catch a malformed config before `fromConfig(...)`. It describes the whole config surface: `schemas` (including `events` and `emitted`), `context`, `requests`, `actors`, `initial`, and `states`, down to choice states, transitions, invokes, and actions.

## Example: a support ticket config

This config drives the examples below: the model triages a ticket (escalate or reply), drafts a reply, then waits for a human to approve or reject. The example ships the equivalent JSON at [examples/json-agent/workflow.json](../examples/json-agent/workflow.json), run by [examples/json-agent/index.ts](../examples/json-agent/index.ts). Model IDs below are illustrative; substitute your provider's current models. As YAML for readability:

```yaml
id: support-ticket-json
schemas:
  input:
    type: object
    properties: { ticket: { type: string } }
    required: [ticket]
  context:
    type: object
    properties:
      ticket: { type: string }
      reply: { type: string }
      resolution: { type: string }
    required: [ticket]
  events:
    ESCALATE:
      type: object
      properties: { reason: { type: string } }
      required: [reason]
    REPLY: { type: object, properties: {} }
    APPROVE: { type: object, properties: {} }
    REJECT: { type: object, properties: {} }
  output:
    type: object
    properties:
      resolution: { type: string }
      reply: { type: string }
    required: [resolution]
  emitted:
    TRIAGED:
      type: object
      properties: { route: { type: string } }
      required: [route]
context:
  ticket: "{{ input.ticket }}"
requests:
  draftReply:
    model: openai/gpt-5.4-mini
    system: "Draft a short, courteous support reply to the customer's ticket."
    prompt: "{{ context.ticket }}"
    input:
      type: object
      properties: { ticket: { type: string } }
      required: [ticket]
    output:
      type: object
      properties: { reply: { type: string } }
      required: [reply]
initial: triaging
states:
  triaging:
    invoke:
      id: triageDecision
      src: agent.decide
      input:
        model: openai/gpt-5.4-mini
        system: "Decide whether this ticket needs human escalation or a drafted reply."
        prompt: "{{ context.ticket }}"
        allowedEvents: [ESCALATE, REPLY]
      onError:
        target: resolved
        assign: { resolution: escalated }
    on:
      ESCALATE:
        target: resolved
        assign: { resolution: escalated }
        actions: { emit: { type: TRIAGED, route: escalated } }
      REPLY:
        target: drafting
        actions: { emit: { type: TRIAGED, route: reply } }
  drafting:
    invoke:
      id: draft
      src: draftReply
      input: { ticket: "{{ context.ticket }}" }
      onDone:
        target: awaitingApproval
        assign: { reply: "{{ event.output.reply }}" }
  awaitingApproval:
    on:
      APPROVE: { target: resolved, assign: { resolution: replied } }
      REJECT: { target: resolved, assign: { resolution: escalated } }
  resolved:
    type: final
    output:
      resolution: "{{ context.resolution }}"
      reply: "{{ context.reply }}"
```

## Schema compilation

<!-- compileSchema requirement and SchemaCompiler from src/workflow-config.ts -->

The `fromConfig` call requires a `compileSchema` option:

- A config carries JSON Schemas (context, events, input, output, and each request's input/output) that need a runtime validator, and the library bundles no JSON Schema engine.
- `compileSchema` takes a JSON Schema object plus a name and returns a Standard Schema validator. `fromConfig(...)` calls it once per schema.
- Use Ajv, `@cfworker/json-schema`, or any compiler that returns Standard Schema.

With Ajv:

```ts
import Ajv from "ajv";
import { setupAgent, type SchemaCompiler, type StandardSchemaV1 } from "@statelyai/agent";

const ajv = new Ajv({ strict: false });

const ajvCompileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
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
      // Expose the source JSON Schema so lint's serializability checks
      // (`unserializable-context`, `final-without-output`) can read the shape.
      jsonSchema: { input: () => jsonSchema },
    },
  };
};

const { machine } = setupAgent.fromConfig(config, { compileSchema: ajvCompileSchema });
```

## Request tools and reasoning

<!-- Request shape from schemas/agent-workflow.json $defs.Request -->

A `requests` entry can also declare:

- `tools`: a map of tool name to `{ description?, inputSchema?, outputSchema? }` (JSON Schemas), passed to the model alongside the request.
- `toolChoice`: `"auto"`, `"none"`, `"required"`, or `{ type: "tool", name }`.
- `reasoning: true`: opts into the structured-output envelope's `reasoning` field.

```yaml
requests:
  lookupOrder:
    model: openai/gpt-5.4-mini
    prompt: "{{ context.ticket }}"
    reasoning: true
    toolChoice: auto
    tools:
      searchOrders:
        description: Find orders by customer email.
        inputSchema:
          type: object
          properties: { email: { type: string } }
          required: [email]
        outputSchema:
          type: object
          properties: { orderIds: { type: array, items: { type: string } } }
    input: { type: object, properties: { ticket: { type: string } } }
    output: { type: object, properties: { summary: { type: string } } }
```

## Named guards and actions

<!-- FromConfigOptions.guards / .actions from src/workflow-config.ts -->

A config cannot carry functions, so anything beyond a truthy dot-path guard goes through a named reference plus a host implementation.

- A string `guard` **without** `{{ }}` is a named guard reference. Implement it in `fromConfig(config, { guards })`, called with `{ context, event }`, returning a boolean.
- An action `{ type, params }` is a named action reference. Implement it in `fromConfig(config, { actions })`, called with the template-resolved `params` as its only argument. Pull context/event data in via `{{ }}` templates on `params`.

```yaml
awaitingApproval:
  on:
    APPROVE:
      target: resolved
      guard: isReady
      actions: { type: notify, params: { ticket: "{{ context.ticket }}" } }
```

```ts
const { machine } = setupAgent.fromConfig(config, {
  compileSchema: ajvCompileSchema,
  guards: { isReady: ({ context }) => Boolean(context.reply) },
  actions: { notify: (params) => console.log("approved", params.ticket) },
});
```

A named reference with no implementation is a build-time error, never a silently dropped guard or action.

## Running a config

A lowered machine runs through `runAgent(...)` like any other agent machine. Pass the machine input, the host `executors`, and `on` handlers for emitted events:

```ts no-check
const result = await runAgent(machine, {
  input: { ticket: "My download link 404s." },
  executors: { decide, generateText },
  on: { TRIAGED: (event) => console.log(event.route) },
});
```

Executor return shapes:

- `decide` returns `{ event: { type, ...payload } }`, the chosen machine event. A bare `{ type }` throws a descriptive error.
- `generateText` / `streamText` return `{ output }`, the structured result matching the request's `output` schema.

A run settles one of two ways:

- `{ status: 'done', output }`: reached a final state.
- `{ status: 'idle', snapshot }`: paused at an idle state. Persist `snapshot`, then resume when the event arrives:

```ts no-check
result = await runAgent(machine, { snapshot, event: { type: "APPROVE" }, executors });
```

> **Note:** An idle state is any state with no `invoke`: nothing runs, so the machine waits for an external event via `on`. A state with an `invoke` is doing work (a decision, a text request, or an `agent.userInput` pause).

> **Note:** Two `prompt`-shaped fields sit at different layers. A `requests` entry's `prompt` is the text sent to the model. An `invoke`'s `input` is the data passed to the invoked source: a request's typed input, or an `agent.decide` inline input carrying its own `model`/`prompt`/`allowedEvents`.

## Expressions

The config is data, not code. Any value is a JSON literal or a whole-string `"{{ }}"` expression: a dot path resolved against `input`, `context`, and `event`. For example, `"{{ context.ticket }}"` reads `context.ticket`. No code, no `eval`: the resolver walks the path and returns the value. Because an expression can only read, a config from a model, database, or visual editor cannot do anything a hand-authored machine could not.

Two fields are exempt: state, invoke, and transition `meta` and a request's `toolChoice` are passed through verbatim, not template-evaluated. A `{{ }}` string there stays a literal string.

## Decisions from JSON

A [decision](decisions.md) works from a config: invoke `src: agent.decide` with `allowedEvents`.

```yaml
states:
  choosing:
    invoke:
      src: agent.decide
      input:
        model: openai/gpt-5.4
        prompt: "{{ context.ticket }}"
        allowedEvents: [ESCALATE, REPLY]
      onError:
        target: escalated
    on:
      ESCALATE: { target: escalated }
      REPLY: { target: drafting }
```

Delivery of the chosen event is automatic: the decision actor sends it to the invoking actor when it resolves, in both TypeScript and JSON. Handle the chosen event with the state's `on` transitions. A decision has no output of its own, so an `onDone` on an `agent.decide` invoke can never fire: `fromConfig(...)` rejects it as a config error. Only `onError` (retries exhausted) applies.

## Choice states and emitted events

Use `type: choice` plus `choice:` for pure routing states, matching TypeScript `type: 'choice'` authoring:

```yaml
states:
  checking:
    type: choice
    choice:
      - guard: "{{ context.score }}"
        target: passed
      - target: failed
  passed:
    entry: { emit: { type: SCORED, value: "{{ context.score }}" } }
    type: final
  failed:
    entry: { emit: { type: SCORED, value: "{{ context.score }}" } }
    type: final
```

Declare emitted event payloads under `schemas.emitted`. Hosts receive them through `runAgent(..., { on: { SCORED: handler } })`, same as hand-authored machines using `enq.emit(...)`.

## Limits of the data form

The data form is narrower than TypeScript authoring, by design:

- Expressions are simple dot paths (`{{ context.foo.bar }}`), not arbitrary JavaScript.
- Guard expressions are **truthy-only**: no `!=`, no comparisons, no boolean operators. For anything else, use a named guard (above).
- Function-valued fields (`allowedEvents`, `input` as functions) cannot appear in JSON.
- `meta` and `toolChoice` are not template-evaluated.

For comparisons or function-valued fields with no named-reference escape hatch, author in TypeScript with `setupAgent(...)` and Zod (or any Standard Schema).

## Verifying a generated machine

A machine built from data can be checked before it runs: no API key, no model call. Lint it with `lintAgentMachine`, simulate a scripted playthrough, or enumerate its decision branches, all in a plain script that CI can run. See [Verify](verify.md).
