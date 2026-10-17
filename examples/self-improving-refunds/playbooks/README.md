# Playbooks

A playbook is the refund desk's inner policy: a JSON `AgentWorkflowConfig` that takes the desk's `Facts` as input and ends in a final state whose output is one proposal event. `createPlaybookDecide` in `../playbook.ts` runs it as the desk's `decide` executor.

- `v0.json`: one `agent.decide` over every proposal, with the rules in the system prompt. One model call per turn; the desk's guards refuse many of its choices.
- `v1.json`: a `choice` ladder over the facts. No text-model call; one Jev judgment (`classifyTicket`) once the order checks out.

## Vocabulary

A playbook authors `context` (with the facts at `context.facts`), its context schema, and `states`. The host injects the rest:

- `schemas.input`, `schemas.events`, `schemas.output`: `Facts`, the proposal events, and a proposal.
- Actor `classifyTicket`: input `{ ticket, customerReplies }`, output `{ isRefundRequest, confidence }`.
- Request `draftQuestion`: input `{ ticket, missing }`, output `{ question }`.
- `agent.decide` with a string model ref and `allowedEvents` drawn from the proposals.
- Named guards from `playbookGuards`: `identityRejected`, `orderBelongsToOtherCustomer`, `overThreshold`. Everything else is a truthy `{{ path }}` guard.

`improvePlaybook` in `../improve.ts` rejects any other actor, request, guard, or named action before a candidate runs.
