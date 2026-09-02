---
title: Machines as data
description: Author an agent machine as a JSON or YAML config and lower it into the same runnable XState machine that setupAgent builds in TypeScript.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

<!-- setupAgent.fromConfig lowering from src/workflow-config.ts -->

This page covers authoring an agent machine as a JSON or YAML config instead of TypeScript.

Describe the machine as a config and pass it to `setupAgent.fromConfig(...)`, imported from the same module as `setupAgent`. It produces the same runnable XState machine that `setupAgent(...)` builds by hand. Configs support states, choice routing, guard-expression transitions, emitted progress events, text requests, decisions, and idle steps. Only the authoring format changes.

```ts
import { setupAgent } from "@statelyai/agent";

const { machine, schemas } = setupAgent.fromConfig(config, {
  compileSchema: ajvCompileSchema,
});
```

> **Bring your own `compileSchema`.** The library bundles no JSON Schema engine. `fromConfig(...)` does not run without a `compileSchema` that you supply. Use Ajv, `@cfworker/json-schema`, or anything that returns a Standard Schema. See [Schema compilation](#schema-compilation).

`fromConfig(...)` returns two values:

- `machine`: the runnable XState machine, ready for `runAgent(...)`.
- `schemas`: the compiled `AgentSchemaPack`. It exposes `context`, `events`, `emitted`, `input`, `output`, and `meta` as Standard Schema validators, for host-side validation and tooling.

A config is portable. You can generate it from a model, store it in a database row, or edit it in a visual builder. It runs the same way as a hand-authored [machine](machines.md).

## Config validation

<!-- schema export path from package.json exports and schemas/agent-workflow.json -->

The package ships a JSON Schema for validating and editing configs:

```ts
import workflowSchema from "@statelyai/agent/agent-workflow.json";
```

Point an editor or form generator at this schema. It describes the whole config surface: `schemas` including `events` and `emitted`, plus `context`, `requests`, `actors`, `initial`, and `states`, down to choice states, transitions, invokes, and actions.

To validate a config in code, call `validateAgentConfig(config)` from `@statelyai/agent/validate`. It checks the value against the same shipped schema and returns `{ valid, errors }`. This subpath uses `ajv` as an optional peer dependency, so install `ajv` to use it.

```ts no-check
import { validateAgentConfig } from "@statelyai/agent/validate";

const { valid, errors } = validateAgentConfig(config);
// errors: { severity: 'error', path: '/states/idle/invoke', message, keyword }[]
```

Validation covers shape only. It does not check that a named guard, action, or actor is implemented, which `fromConfig(...)` does when it lowers the config.

### Division of labor

Run `validateAgentConfig` first. `fromConfig(...)` does not validate the config against the JSON Schema, so a malformed config reaches lowering unchecked.

`fromConfig(...)` throws plain `Error`s, and only for lowering problems: an unknown state target, a guard or action name with no implementation, an `onDone` on an `agent.decide` invoke, a reserved `'.'` in a key, a malformed `choice` branch, and an `idleTags` entry that no state declares.

### Reserved key prefix

The `agent.` prefix belongs to the library. `setupAgent` throws when a `requests` or `actors` key starts with `agent.`, including the builtin names `agent.generateText`, `agent.streamText`, `agent.decide`, and `agent.userInput`. Rename the key without the prefix. To override a builtin deliberately, do it on the created machine with `machine.provide({ actors })`.

## Expressions

The config is data, not code. Every value is either a JSON literal or a whole-string `"{{ }}"` expression. An expression is a dot path resolved against `input`, `context`, and `event`. For example, `"{{ context.ticket }}"` reads `context.ticket`. The resolver walks the path and returns the value. There is no code evaluation and no `eval`. An expression can only read values, so a config produced by a model, a database, or a visual editor cannot do anything a hand-authored machine could not do.

Two fields are exempt from template evaluation. State, invoke, and transition `meta`, and a request's `toolChoice`, are passed through verbatim. A `{{ }}` string in those fields stays a literal string.

## Example: a support ticket config

The config below drives the examples on the rest of this page. The model triages a ticket as escalate or reply, drafts a reply, then waits for a human to approve or reject. The equivalent JSON ships at [examples/json-agent/workflow.json](../examples/json-agent/workflow.json) and is run by [examples/json-agent/index.ts](../examples/json-agent/index.ts). Model IDs are illustrative. Substitute your provider's current models. The config is shown as YAML for readability.

<!-- viz: support-ticket machine: triaging (agent.decide) -> resolved on ESCALATE, -> drafting on REPLY; drafting -> awaitingApproval on draft onDone; awaitingApproval -> resolved on APPROVE or REJECT; mark awaitingApproval as the idle state -->


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

The `fromConfig` call requires a `compileSchema` option.

- A config carries JSON Schemas for context, events, input, output, and each request's input and output. Those schemas need a runtime validator, and the library bundles no JSON Schema engine.
- `compileSchema` takes a JSON Schema object and a name, and returns a Standard Schema validator. `fromConfig(...)` calls it once per schema.
- Use Ajv, `@cfworker/json-schema`, or any compiler that returns a Standard Schema.

Expose the source JSON Schema on the validator you return, as `jsonSchema: { input: () => schema }`. `lintAgentMachine` reads it to run the checks that need the declared shape, `unserializable-context` and `final-without-output`. Those checks are skipped when it is absent.

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
      jsonSchema: { input: () => jsonSchema },
    },
  };
};

const { machine } = setupAgent.fromConfig(config, { compileSchema: ajvCompileSchema });
```

## Request tools and reasoning

<!-- Request shape from schemas/agent-workflow.json $defs.Request -->

A `requests` entry can also declare these fields.

| Field | Value | Effect |
| --- | --- | --- |
| `tools` | Map of tool name to `{ description?, inputSchema?, outputSchema? }`, where the schemas are JSON Schemas | Passes the tools to the model alongside the request. |
| `toolChoice` | `"auto"`, `"none"`, `"required"`, or `{ type: "tool", name }` | Controls whether the model must call a tool. |
| `includeReasoning` | `true` | Opts into the `reasoning` field of the structured-output envelope. |

```yaml
requests:
  lookupOrder:
    model: openai/gpt-5.4-mini
    prompt: "{{ context.ticket }}"
    includeReasoning: true
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

A config cannot carry functions. Anything beyond a truthy dot-path guard uses a named reference plus a host implementation.

- A string `guard` without `{{ }}` is a **named guard** reference. Implement it in `fromConfig(config, { guards })`. The implementation is called with `{ context, event }` and returns a boolean.
- An action `{ type, params }` is a **named action** reference. Implement it in `fromConfig(config, { actions })`. The implementation is called with the template-resolved `params` as its only argument. To pass context or event data, use `{{ }}` templates on `params`.

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

A named reference with no implementation is a build-time error. The guard or action is never silently dropped.

## Host-provided actors

<!-- config.actors and createActorPlaceholdersFromWorkflowConfig from src/workflow-config.ts -->

The top-level `actors` key declares actor sources that the config does not implement, such as a database read or a queue round trip. Each entry takes an optional `input` and `output` JSON Schema and a `description`. States invoke the source by its key.

```yaml
actors:
  fetchOrder:
    description: Load the order referenced by the ticket.
    input:
      type: object
      properties: { ticket: { type: string } }
    output:
      type: object
      properties: { orderId: { type: string } }
```

`fromConfig(...)` lowers each entry to a placeholder that throws when invoked, naming the key. Supply the implementation on the returned machine.

```ts no-check
const { machine } = setupAgent.fromConfig(config, { compileSchema: ajvCompileSchema });

const bound = machine.provide({
  actors: { fetchOrder: createAsyncLogic({ run: ({ input }) => loadOrder(input.ticket) }) },
});
```

Use `actors` for work the host executes directly. Use `requests` for model calls, which the executors bind automatically.

## Running configs

A machine built by `fromConfig(...)` runs through `runAgent(...)` like any other agent machine. Pass the machine input, the host `executors`, and `on` handlers for emitted events.

```ts no-check
const result = await runAgent(machine, {
  input: { ticket: "My download link 404s." },
  executors: { decide, generateText },
  on: { TRIAGED: (event) => console.log(event.route) },
});
```

Executors return these shapes.

| Executor | Returns | Notes |
| --- | --- | --- |
| `decide` | `{ event: { type, ...payload } }` | The chosen machine event. A bare `{ type }` throws a descriptive error. |
| `generateText`, `streamText` | `{ output }` | The structured result matching the request's `output` schema. |

A run settles in one of two ways.

- `{ status: 'done', output }`: the machine reached a final state.
- `{ status: 'idle', snapshot }`: the machine paused at an idle state. Persist `snapshot`, then resume when the event arrives.

<!-- viz: run lifecycle: runAgent -> running -> settles as { status: 'done', output } or { status: 'idle', snapshot }, with the idle branch looping back into runAgent({ snapshot, event }) -->


```ts no-check
result = await runAgent(machine, { snapshot, event: { type: "APPROVE" }, executors });
```

> **Note:** By default, an **idle state** is an active snapshot that accepts an external event anywhere in its active hierarchy, or has `meta.interaction`. `runAgent` also verifies that no invoked child, eventless transition, or delayed transition is still working.

> **Note:** Two `prompt`-shaped fields sit at different layers. A `requests` entry's `prompt` is the text sent to the model. An `invoke`'s `input` is the data passed to the invoked source. That is either a request's typed input, or an `agent.decide` inline input carrying its own `model`, `prompt`, and `allowedEvents`.

## Idle declaration

`runAgent` uses its exported `isAgentIdle(snapshot)` rule by default. A config can replace that predicate with `idleTags`; this is the declarative form of `setupAgent({ isIdle })`, because JSON cannot carry a function.

```yaml
idleTags: [awaiting-approval]
states:
  awaitingApproval:
    tags: [awaiting-approval]
    on:
      APPROVE: { target: resolved }
```

- `fromConfig(...)` converts the list into a `snapshot.hasTag(...)` predicate. Every listed tag must appear in some state's `tags`. An unused entry is a build-time error.
- For predicates that a tag list cannot express, pass a function instead: `setupAgent.fromConfig(config, { isIdle })`. The function takes precedence over `idleTags` and remains machine-owned. Import `isAgentIdle` and call it inside that predicate when expanding, rather than replacing, the default rule.

## Decisions from JSON

A [decision](decisions.md) works from a config. Invoke `src: agent.decide` with `allowedEvents`.

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

The chosen event is delivered automatically. When the decision actor resolves, it sends the event to the invoking actor, in both TypeScript and JSON. Handle the chosen event with the state's `on` transitions.

A decision has no output of its own, so an `onDone` on an `agent.decide` invoke can never fire. `fromConfig(...)` rejects it as a config error. Only `onError` applies, and it fires when retries are exhausted.

<!-- viz: agent.decide flow: state invokes agent.decide with allowedEvents -> model picks one event -> actor sends the event to the invoking actor -> the state's `on` transition runs; onError branch when retries are exhausted -->

## Choice states and emitted events

Use `type: choice` with a `choice` array for routing states that do no work. This matches `type: 'choice'` authoring in TypeScript.

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

Declare emitted event payloads under `schemas.emitted`. Hosts receive them through `runAgent(..., { on: { SCORED: handler } })`, the same as for hand-authored machines that use `enq.emit(...)`.

## Limits of the data form

The data form is narrower than TypeScript authoring.

- Expressions are dot paths such as `{{ context.foo.bar }}`, not arbitrary JavaScript.
- Guard expressions are truthy-only. They support no `!=`, no comparisons, and no boolean operators. For anything else, use a named guard. See [Named guards and actions](#named-guards-and-actions).
- Function-valued fields cannot appear in JSON. This includes `allowedEvents` and `input` when written as functions.
- `meta` and `toolChoice` are not template-evaluated.

For comparisons, or for function-valued fields that have no named-reference equivalent, author the machine in TypeScript with `setupAgent(...)` and Zod or any other Standard Schema library.

## Related

- [Testing and verification](verify.md): check a lowered machine before it runs, with no API key and no model call. Lint it with `lintAgentMachine`, simulate a scripted playthrough, or enumerate its decision branches, all from a script CI can run.
- [Generating machines with an LLM](generate-machines.md): the generate → validate → lint → simulate pipeline.
- [Agent machines](machines.md): the TypeScript authoring form a config lowers to.
- [Decisions](decisions.md): `agent.decide` from a config.
- [examples/json-agent](../examples/json-agent/index.ts): a hand-written config, run.
