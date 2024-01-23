# Stately Agent (alpha)

🚧 Documentation in progress! Please see [the examples directory](https://github.com/statelyai/agent/tree/main/examples) for working examples.

## Installation

Install `openai`, and `@statelyai/agent`:

```bash
npm install openai @statelyai/agent
```

## Usage

Work in progress. For now, see the examples:

- [joke](https://github.com/statelyai/agent/tree/main/examples/joke.ts)
  - Demonstrates `agent.fromChatCompletion(...)` to generate a joke and provide a joke rating
  - Demonstrates `agent.fromEventChoice(...)` to choose whether to keep generating jokes or stop
- [Tic-tac-toe](https://github.com/statelyai/agent/tree/main/examples/ticTacToe.ts)
  - Demonstrates `agent.fromEventChoice(...)` to have an agent play itself in a game of tic-tac-toe with precise events
  - Demonstrates `agent.fromChatCompletionStream(...)` to produce a game report at the end of the game

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
