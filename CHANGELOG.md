# @statelyai/agent

## 2.0.0-alpha.0

### Major Changes

- [#67](https://github.com/statelyai/agent/pull/67) [`d750efc`](https://github.com/statelyai/agent/commit/d750efcf98f21ce6ca250a2944521fa8e0b3f09a) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Rewrite `@statelyai/agent` as a typed, host-agnostic authoring layer for agent state machines on XState v6. The machine is a portable blueprint: it decides which states exist, which model calls happen, and which events are legal right now; your host executes them with any SDK.

  **Authoring**

  - `setupAgent({ schemas | context/events/input/output/meta, actors, requests })`: schema-first machine authoring (Standard Schema — Zod, Valibot, ArkType) with typed context, events, invoke inputs/outputs, and state/transition `meta`.
  - `createTextLogic(...)` for reusable, schema-typed model calls; co-located `requests:` for inline ones.
  - **Decisions**: the model chooses exactly one _currently-legal_ machine event. Author state-locally with the `agent.decide` builtin (typed `allowedEvents` against your event schema keys; omitted = all currently-legal events) plus `sendDecision()`, or reusably with `createDecisionLogic(...)`. Core validates (`unknown-event` / `invalid-payload` / `rejected-by-guard` via `snapshot.can`) and retries with attempts fed back to the model; how the model is coerced is adapter business.
  - **Machines as data**: full agent workflows — states, transitions, guards, text requests, decisions, human steps — can be defined as pure JSON, validated against the published `@statelyai/agent/agent-workflow.json` schema, and lowered with `setupAgent.fromConfig(...)`. `fromConfig(...)` requires a `compileSchema` option to compile the config's JSON Schemas into runtime validators — bring your own engine (Ajv, @cfworker/json-schema, ...) or pass the exported `minimalSchemaCompiler` to opt into the built-in subset validator (type/properties/required/items/enum/const only).

  **Messages**

  - `AgentMessage` is a parts-based discriminated union (system/user/assistant/tool with text/image/file/tool-call/tool-result parts), structurally mirroring AI SDK `ModelMessage` with no dependency on `ai`. Adds `toolMessage(...)`; `messagesSchema` validates roles and per-role content shapes.

  **Running**

  - `runAgent(machine, { input, generateText, streamText?, decide?, ... })`: bind executors, run to settlement, get `{ status: 'done' | 'idle' | 'error' }`. Idle-first human-in-the-loop: waiting states settle `idle` with a JSON-serializable snapshot; resume with `{ snapshot, event }`. Observation-only callbacks (`onTransition`, `onResult`, `onChunk`); `maxModelCalls` budget; `AbortSignal` support; bind-time errors for anything unbound.
  - Step path for durable hosts: `initialAgentStep` / `transitionAgentStep` / `resolveAgentStep` / `resolveDecision` give per-model-call checkpoints (Cloudflare Workflows, Temporal, etc.); `step.requests` is a `kind`-discriminated union of text and decision requests; delayed transitions surface as schedulable actions.
  - `createAiSdkExecutors({ resolveModel })` from `@statelyai/agent/ai-sdk`: the shipped Vercel AI SDK adapter (structured output, streaming with chunk observation, tool-per-event decide, `metadata.maxSteps` tool loops). `ai` is an optional peer dependency; core depends only on `xstate` (peer).

  **Removed / breaking**

  - `createAgentMachine(...)`, `@statelyai/agent/local`, and the custom runtime surface: runtime is normal XState actors and snapshots.
  - `agentEvents` / `eventTypes` (event tools on text requests) → replaced by decisions and `allowedEvents`.
  - `getAvailableEvents` → `getAcceptedEvents`; `getEventTools` and `AgentRequestLogic` removed.
  - `runAgent` returns the `done | idle | error` status union instead of the machine output, and never throws on a waiting machine.
  - `AgentMessage` is the new union shape; the open index signature is gone. Persisted contexts holding old-shape messages need manual migration.
  - Executor results are unwrapped as `object → text → output`; `toolResults` inspection removed.

## 1.1.6

### Patch Changes

- [#54](https://github.com/statelyai/agent/pull/54) [`140fdce`](https://github.com/statelyai/agent/commit/140fdceb879dea5a32f243e89a8d87a9c524e454) Thanks [@XavierDK](https://github.com/XavierDK)! - - Addressing an issue where the fullStream property was not properly copied when using the spread operator (...). The problem occurred because fullStream is an iterator, and as such, it was not included in the shallow copy of the result object.
  - Update all packages

## 1.1.5

### Patch Changes

- [#49](https://github.com/statelyai/agent/pull/49) [`ae505d5`](https://github.com/statelyai/agent/commit/ae505d56b432a92875699507fb694628ef4d773d) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update `ai` package

## 1.1.4

### Patch Changes

- [#47](https://github.com/statelyai/agent/pull/47) [`185c149`](https://github.com/statelyai/agent/commit/185c1498f63aef15a3194032df3dcdcb2b33d752) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update `ai` and `xstate` packages

## 1.1.3

### Patch Changes

- [#45](https://github.com/statelyai/agent/pull/45) [`3c271f3`](https://github.com/statelyai/agent/commit/3c271f306c4ed9553c155e66cec8aa4284e9c813) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Fix reading the actor logic

## 1.1.2

### Patch Changes

- [#43](https://github.com/statelyai/agent/pull/43) [`8e7629c`](https://github.com/statelyai/agent/commit/8e7629c347b29b704ae9576aa1af97e6cd693bc7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update dependencies

## 1.1.1

### Patch Changes

- [#41](https://github.com/statelyai/agent/pull/41) [`b2f2b73`](https://github.com/statelyai/agent/commit/b2f2b7307e96d7722968769aae9db2572ede8ce7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update dependencies

## 1.1.0

### Minor Changes

- [#39](https://github.com/statelyai/agent/pull/39) [`3cce30f`](https://github.com/statelyai/agent/commit/3cce30fc77d36dbed0abad805248de9f64bf8086) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Added four new methods for easily retrieving agent messages, observations, feedback, and plans:

  - `agent.getMessages()`
  - `agent.getObservations()`
  - `agent.getFeedback()`
  - `agent.getPlans()`

  The `agent.select(…)` method is deprecated in favor of these methods.

- [#40](https://github.com/statelyai/agent/pull/40) [`8b7c374`](https://github.com/statelyai/agent/commit/8b7c37482d5c35b2b3addc2f88e198526f203da7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Correlation IDs are now provided as part of the result from `agent.generateText(…)` and `agent.streamText(…)`:

  ```ts
  const result = await agent.generateText({
    prompt: "Write me a song",
    correlationId: "my-correlation-id",
    // ...
  });

  result.correlationId; // 'my-correlation-id'
  ```

  These correlation IDs can be passed to feedback:

  ```ts
  // ...

  agent.addFeedback({
    reward: -1,
    correlationId: result.correlationId,
  });
  ```

- [#40](https://github.com/statelyai/agent/pull/40) [`8b7c374`](https://github.com/statelyai/agent/commit/8b7c37482d5c35b2b3addc2f88e198526f203da7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Changes to agent feedback (the `AgentFeedback` interface):

  - `goal` is now optional
  - `observationId` is now optional
  - `correlationId` has been added (optional)
  - `reward` has been added (optional)
  - `attributes` are now optional

- [#38](https://github.com/statelyai/agent/pull/38) [`21fb17c`](https://github.com/statelyai/agent/commit/21fb17c65fac1cbb4a8b08a04a58480a6930a0a9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - You can now add `context` Zod schema to your agent. For now, this is meant to be passed directly to the state machine, but in the future, the schema can be shared with the LLM agent to better understand the state machine and its context for decision making.

  Breaking: The `context` and `events` types are now in `agent.types` instead of ~~`agent.eventTypes`.

  ```ts
  const agent = createAgent({
    // ...
    context: {
      score: z.number().describe("The score of the game"),
      // ...
    },
  });

  const machine = setup({
    types: agent.types,
  }).createMachine({
    context: {
      score: 0,
    },
    // ...
  });
  ```

### Patch Changes

- [`5f863bb`](https://github.com/statelyai/agent/commit/5f863bb0d89d90f30d0a9aa1f0dd2a35f0eeb45b) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Use nanoid

- [#37](https://github.com/statelyai/agent/pull/37) [`dafa815`](https://github.com/statelyai/agent/commit/dafa8157cc1b5adbfb222c146dbc84ab2eed8894) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Messages are now properly included in `agent.decide(…)`, when specified.

## 0.1.0

### Minor Changes

- [#32](https://github.com/statelyai/agent/pull/32) [`537f501`](https://github.com/statelyai/agent/commit/537f50111b5f8edc1a309d1abb8fffcdddddbc03) Thanks [@davidkpiano](https://github.com/davidkpiano)! - First minor release of `@statelyai/agent`! The API has been simplified from experimental earlier versions. Here are the main methods:

  - `createAgent({ … })` creates an agent
  - `agent.decide({ … })` decides on a plan to achieve the goal
  - `agent.generateText({ … })` generates text based on a prompt
  - `agent.streamText({ … })` streams text based on a prompt
  - `agent.addObservation(observation)` adds an observation and returns a full observation object
  - `agent.addFeedback(feedback)` adds a feedback and returns a full feedback object
  - `agent.addMessage(message)` adds a message and returns a full message object
  - `agent.addPlan(plan)` adds a plan and returns a full plan object
  - `agent.onMessage(cb)` listens to messages
  - `agent.select(selector)` selects data from the agent context
  - `agent.interact(actorRef, getInput)` interacts with an actor and makes decisions to accomplish a goal

## 0.0.8

### Patch Changes

- [#22](https://github.com/statelyai/agent/pull/22) [`8a2c34b`](https://github.com/statelyai/agent/commit/8a2c34b8a99161bf47c72df8eed3f5d3b6a19f5f) Thanks [@davidkpiano](https://github.com/davidkpiano)! - The `createSchemas(…)` function has been removed. The `defineEvents(…)` function should be used instead, as it is a simpler way of defining events and event schemas using Zod:

  ```ts
  import { defineEvents } from "@statelyai/agent";
  import { z } from "zod";
  import { setup } from "xstate";

  const events = defineEvents({
    inc: z.object({
      by: z.number().describe("Increment amount"),
    }),
  });

  const machine = setup({
    types: {
      events: events.types,
    },
    schema: {
      events: events.schemas,
    },
  }).createMachine({
    // ...
  });
  ```

## 0.0.7

### Patch Changes

- [#18](https://github.com/statelyai/agent/pull/18) [`dcaabab`](https://github.com/statelyai/agent/commit/dcaababe69255b7eaff3347d0cf09469d3e6cc78) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `context` is now optional for `createSchemas(…)`

## 0.0.6

### Patch Changes

- [#16](https://github.com/statelyai/agent/pull/16) [`3ba5fb2`](https://github.com/statelyai/agent/commit/3ba5fb2392b51dee71f2585ed662b4ee9ecd6c41) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update to XState 5.8.0

## 0.0.5

### Patch Changes

- [#9](https://github.com/statelyai/agent/pull/9) [`d8e7b67`](https://github.com/statelyai/agent/commit/d8e7b673f6d265f37b2096b25d75310845860271) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add `adapter.fromTool(…)`, which creates an actor that chooses agent logic based on a input.

  ```ts
  const actor = adapter.fromTool(() => "Draw me a picture of a donut", {
    // tools
    makeIllustration: {
      description: "Makes an illustration",
      run: async (input) => {
        /* ... */
      },
      inputSchema: {
        /* ... */
      },
    },
    getWeather: {
      description: "Gets the weather",
      run: async (input) => {
        /* ... */
      },
      inputSchema: {
        /* ... */
      },
    },
  });

  //...
  ```

## 0.0.4

### Patch Changes

- [#5](https://github.com/statelyai/agent/pull/5) [`ae473d7`](https://github.com/statelyai/agent/commit/ae473d73399a15ac3199d77d00eb44a0ea5626db) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Simplify API (WIP)

- [#5](https://github.com/statelyai/agent/pull/5) [`687bed8`](https://github.com/statelyai/agent/commit/687bed87f29bd1d13447cc53b5154da0fe6fdcab) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add `createSchemas`, `createOpenAIAdapter`, and change `createAgent`

## 0.0.3

### Patch Changes

- [#1](https://github.com/statelyai/agent/pull/1) [`3dc2880`](https://github.com/statelyai/agent/commit/3dc28809a7ffd915a69d9f3374531c31fc1ee357) Thanks [@mellson](https://github.com/mellson)! - Adds a convenient way to run the examples with `pnpm example ${exampleName}`. If no example name is provided, the script will print the available examples. Also, adds a fun little loading animation to the joke example.

## 0.0.2

### Patch Changes

- e125728: Added `createAgent(...)`
