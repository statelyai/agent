# @statelyai/agent

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
