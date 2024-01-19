# Stately Agent (alpha)

🚧 Documentation in progress! Please see [the examples directory](https://github.com/statelyai/agent/tree/main/examples) for working examples.

## Installation

Install `openai`, and `@statelyai/agent`:

```bash
npm install openai @statelyai/agent
```

## Usage

```ts
import { createAgent } from '@statelyai';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 1. Create a Stately Agent.
// These agents are provided with context and events relevant to
// the domain they will be working in.
const agent = createAgent(openai, {
  model: 'gpt-4-1106-preview',
  context: {
    jokes: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    topic: {
      type: 'string',
    },
  },
  events: {
    getJoke: {
      description: 'Get a joke',
      properties: {
        topic: {
          type: 'string',
        },
      },
    },
  },
});

// 2. Create agent logic
// This agent logic can be ran standalone,
// or as part of a state machine.
const getJoke = agent.fromChatCompletion(
  (topic: string) => `Give me a joke about ${topic}`
);

// ... More agent logic here

// 3. Create a state machine
const jokeMachine = setup({
  types: typeof agent.types,
  actors: {
    getJoke,
    // ...
  },
}).createMachine({
  // Instead of a contrived example, see a real example here:
  // https://github.com/statelyai/agent/tree/main/examples/joke.ts
});

const jokeActor = createActor(jokeMachine);
jokeActor.subscribe((state) => {
  console.log(state.value, state.context);
});
jokeActor.start();
```

## Examples

First, clone this repo locally. To run the examples in this repo, create a `.env` file at the root of the repo with the following contents:

```bash
OPENAI_API_KEY="your-openai-api-key"
```

Then, install the dependencies (`npm install`) and run the examples:

```bash
npm run example joke
# or:
# npm run example ticTacToe
```
