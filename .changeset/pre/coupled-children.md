---
"@statelyai/agent": minor
---

`explorePaths`/`canReach`: `children: "coupled"` steps each child machine inside the parent's search, so a witness is a run the machines can make together. A child's events reach the parent in the child's own order, its output follows them, and the parent's `sendTo`/`forwardTo` sends are applied to the child as made (no `childEvents` entry needed). New `hostEvents` option lists the event types the host can send the machine, so child-only status events are not offered as host events.
