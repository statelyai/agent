# Stately Expert

Stately Expert is a flexible framework for building AI agents using state machines. Stately agents go beyond normal LLM-based AI agents by:

- Using state machines to guide the agent's behavior, powered by [XState](https://stately.ai/docs/xstate)
- Incorporating **observations**, **message history**, and **feedback** to the agent decision-making and text-generation processes, as needed
- Enabling custom **planning** abilities for agents to achieve specific goals based on state machine logic, observations, and feedback
- First-class integration with the [Vercel AI SDK](https://sdk.vercel.ai/) to easily support multiple model providers, such as OpenAI, Anthropic, Google, Mistral, Groq, Perplexity, and more

**Read the documentation: [github.com/statelyai/agent](https://github.com/statelyai/agent)**

# Stately Expert

Stately Expert is a framework for building intelligent AI agents that are guided by state machines and learn from experience. Rather than relying solely on LLM responses, agents use structured observations, feedback, and insights to make informed decisions and improve over time.

## Overview

Stately Expert combines state machines with reinforcement learning concepts to create agents that:

- Make decisions based on clear state transitions and goals
- Learn from past experiences and feedback
- Generate insights about state changes
- Improve decision-making through structured rewards
- Support multiple decision-making policies

The framework is built on [XState](https://stately.ai/docs/xstate) for state machine management and integrates with the [Vercel AI SDK](https://sdk.vercel.ai/) for flexible LLM support.

## Key Concepts

- **Observations**: Records of state transitions, containing:

  - Previous state
  - Event/action taken
  - Resulting state
  - Metadata about the transition

- **Decisions**: Actions the agent chooses to take based on:

  - Current state
  - Goal state
  - Past observations
  - Available feedback and insights
  - Decision-making policy

- **Feedback**: Rewards or evaluations given to decisions, helping the agent learn which actions are effective

- **Insights**: Additional context about state transitions, helping the agent understand cause and effect

- **Episodes**: Complete sequences of state transitions, from initial state to goal state (similar to RL episodes)

## Quick Start

TODO

## Why Stately Expert?

Traditional LLM-based agents often make decisions with limited context and no ability to learn from experience. Stately Expert provides:

1. **Structured Decision Making**: State machines provide clear boundaries and valid transitions

2. **Learning from Experience**: Experts improve through feedback and observations

3. **Contextual Awareness**: Insights and observations inform better decisions

4. **Flexible Policies**: Different approaches for different needs

5. **Storage Integration**: Optional persistence of experiences and learning
