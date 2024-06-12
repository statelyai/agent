---
'@statelyai/agent': minor
---

First minor release of `@statelyai/agent`! The API has been simplified from experimental earlier versions. Here are the main methods:

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
