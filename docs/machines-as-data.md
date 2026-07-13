---
title: Machines as data
description: Author an agent machine as a JSON or YAML config and lower it into the same runnable XState machine that setupAgent builds in TypeScript.
---

## Machines as data

<!-- setupAgent.fromConfig lowering from src/workflow-config.ts -->

An agent machine can be pure data. Describe it as a JSON or YAML config and hand it to `setupAgent.fromConfig(...)`. The lowering produces the same kind of runnable XState machine that `setupAgent(...)` builds by hand: states, choice routing, transitions with guard expressions, emitted progress events, text requests, decisions, and human/idle steps included. Only the authoring format changes.

```ts
import { setupAgent } from '@statelyai/agent';

const machine = setupAgent.fromConfig(config, { compileSchema });
```

A config is portable: generate it from a model, store it in a database row, or edit it in a visual builder, and it runs exactly like a hand-authored [machine](machines.md).

## The published JSON Schema

<!-- schema export path from package.json exports and schemas/agent-workflow.json -->

The package ships a JSON Schema for validating and editing configs:

```ts
import workflowSchema from '@statelyai/agent/agent-workflow.json';
```

Point an editor, form generator, or validation step at it to catch a malformed config before it reaches `fromConfig(...)`. It describes the whole config surface: `schemas` (including `events` and `emitted`), `context`, `requests`, `actors`, `initial`, and `states`, down to choice states, transitions, invokes, and actions.

## Running example: a support ticket

The rest of this page uses one config: the model triages a ticket (escalate or reply), drafts a reply when replying, then waits for a human to approve or reject. It is a real `.json` file at [examples/json-agent/workflow.json](../examples/json-agent/workflow.json), run by [examples/json-agent/index.ts](../examples/json-agent/index.ts). Here it is as YAML for readability:

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

A config carries JSON Schemas (context, events, input, output, and each request's input/output), and those need a runtime validator. The library bundles no JSON Schema engine, so it does not guess how strictly to validate: you bring the engine. `compileSchema` takes a JSON Schema object and a name and returns a Standard Schema validator; `fromConfig(...)` calls it once per schema.

`fromConfig` requires a `compileSchema` option. Core intentionally ships no
JSON Schema engine; bring Ajv, @cfworker/json-schema, or another compiler that
returns Standard Schema. Ajv recipe:

```ts
import Ajv from 'ajv';
import { setupAgent, type SchemaCompiler, type StandardSchemaV1 } from '@statelyai/agent';

const ajv = new Ajv({ strict: false });

const ajvCompileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
  const validate = ajv.compile(jsonSchema);
  return {
    '~standard': {
      version: 1,
      vendor: 'ajv',
      validate: (value) =>
        validate(value)
          ? { value }
          : { issues: (validate.errors ?? []).map((e) => ({ message: `${name} ${e.message}` })) },
    },
  };
};

const machine = setupAgent.fromConfig(config, { compileSchema: ajvCompileSchema });
```

## Expressions

The config is data, not code. Any value is a JSON literal or a whole-string `"{{ }}"` expression: a dot path resolved against `input`, `context`, and `event`. `"{{ context.ticket }}"` reads `context.ticket`; `"{{ event.output.reply }}"` reads `event.output.reply`. There is no code and no `eval`; the resolver walks the path and returns the value.

Because an expression can only read a value, a config generated by a model, stored in a database, or produced by a visual editor cannot do anything a hand-authored machine could not do.

## Decisions from JSON

A [decision](decisions.md) works from a config too: invoke `src: agent.decide` with `allowedEvents`.

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

Delivery of the chosen event is automatic — the decision actor sends it to the invoking actor when it resolves, in both TypeScript and JSON. That event's transition usually exits the invoking state, cancelling the invoke, so `onDone` normally never fires; it is optional and only observed when the chosen event's transition stays in-state. Only `onError` (retries exhausted) is commonly configured.

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

Declare emitted event payloads under `schemas.emitted`. Hosts receive them through `runAgent(..., { on: { SCORED: handler } })`, the same as hand-authored machines using `enq.emit(...)`.

## Honest limits

The data form is narrower than TypeScript authoring, by design:

- Expressions are simple dot paths (`{{ context.foo.bar }}`), not arbitrary JavaScript.
- Guard expressions are **truthy-only**: no `!=`, no comparisons, no boolean operators.
- Function-valued fields (`allowedEvents`, `guard`, `input` as functions) cannot appear in JSON at all.

When you need comparisons, computed guards, or function-valued fields, author in TypeScript with `setupAgent(...)` and Zod (or any Standard Schema).

## Verifying a generated machine

A machine built from data can be checked before it ever runs — no API key, no model call. Lint it with `lintAgentMachine`, simulate a scripted playthrough, or enumerate its decision branches. The `statelyai-agent lint <workflow.json>` CLI does this for a JSON config in CI. See [verify](verify).
