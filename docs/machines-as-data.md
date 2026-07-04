---
title: Machines as data
description: Author an agent machine as a JSON or YAML config and lower it into the same runnable XState machine that setupAgent builds in TypeScript.
---

## Machines as data

<!-- setupAgent.fromConfig lowering from src/workflow-config.ts -->

An agent machine can be pure data. Describe it as a JSON or YAML config and hand it to `setupAgent.fromConfig(...)`. The lowering produces the same kind of runnable XState machine that `setupAgent(...)` builds by hand: states, transitions with guard expressions, text requests, decisions, and human/idle steps included. Only the authoring format changes.

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

Point an editor, form generator, or validation step at it to catch a malformed config before it reaches `fromConfig(...)`. It describes the whole config surface: `schemas`, `context`, `requests`, `actors`, `initial`, and `states`, down to transitions, invokes, and actions.

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
      ESCALATE: { target: resolved, assign: { resolution: escalated } }
      REPLY: { target: drafting }
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

Wire up Ajv when correctness matters:

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

For a zero-dependency, low-stakes config boundary, opt into the built-in subset validator:

```ts
import { minimalSchemaCompiler, setupAgent } from '@statelyai/agent';

const machine = setupAgent.fromConfig(config, { compileSchema: minimalSchemaCompiler });
```

> **Warning:** `minimalSchemaCompiler` honors only `type`, `properties`, `required`, `items`, `enum`, and `const`. Everything else (`pattern`, `format`, `minLength`, `additionalProperties`, `$ref`, `anyOf`, and the rest) is **silently ignored**, so a value can pass while violating those keywords. Use a real engine like Ajv when you need full JSON Schema semantics.

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

Delivery of the chosen event is automatic. TypeScript authoring writes `onDone: sendDecision()`, but JSON cannot express a function, so the lowering wires it up; declaring `onDone` on an `agent.decide` invoke is an error. Only `onError` (retries exhausted) is configurable.

## Honest limits

The data form is narrower than TypeScript authoring, by design:

- Expressions are simple dot paths (`{{ context.foo.bar }}`), not arbitrary JavaScript.
- Guard expressions are **truthy-only**: no `!=`, no comparisons, no boolean operators.
- Function-valued fields (`allowedEvents`, `guard`, `input` as functions) cannot appear in JSON at all.

When you need comparisons, computed guards, or function-valued fields, author in TypeScript with `setupAgent(...)` and Zod (or any Standard Schema).
