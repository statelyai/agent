An agent is like a language model that wraps:

- generateText()
- streamText()

A plan is a sequence of events and predicted states to reach a goal.

Agents also have internal state:

- observations: an array of observed states
- history: an array of messages to/from the language model
- plans: an array of plans
- feedback: an array of feedback items, which is used to determine the reward
