---
"@statelyai/agent": minor
---

`describeMachine(machine, { format: "mermaid" })` renders a machine as a Mermaid `stateDiagram-v2` diagram, with no network connection. It draws one edge per target that a transition written as a function can return, marks conditional ones with `?`, and sends targets it cannot read to a dashed `?` node. GitHub renders the output in Markdown.
