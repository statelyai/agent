# @statelyai/agent

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
