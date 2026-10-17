# Playbooks

A playbook is the refund desk's malleable policy: a JSON `AgentWorkflowConfig` that takes the desk's facts plus this turn's offered options as input and ends in a final state whose output is one proposal event. `createPlaybookDecide` in `../playbook.ts` runs it as a `decide` executor at the desk's boundary. Its output must equal one of the offered options; anything else is retried, and the desk escalates when the retries run out.

- `v0.json`: one `agent.decide` closed choice over the offered options (`payloads: "{{ context.facts.payloads }}"`), with the rules in the system prompt. One model call per turn.
- `v1.json`: a `choice` ladder over the facts. No text-model call; one Jev judgment (`classifyTicket`) once the order checks out.

## Vocabulary

A playbook authors `context` (with its input at `context.facts`), its context schema, and `states`. The host injects the rest:

- `schemas.input`, `schemas.events`, `schemas.output`: the facts plus `payloads` (offered options per proposal type), the proposal events, and a proposal.
- Actor `classifyTicket`: input `{ ticket, customerReplies }`, output `{ isRefundRequest, confidence }`.
- Request `draftQuestion`: input `{ ticket, missing }`, output `{ question }`.
- `agent.decide` with the literal model ref `openai/gpt-5.4-mini` and `allowedEvents` drawn from the proposals.
- Named guards from `playbookGuards`: `identityRejected`, `orderBelongsToOtherCustomer`, `overThreshold`. Everything else is a truthy `{{ path }}` guard.

`improvePlaybook` in `../improve.ts` gates every candidate with `verifyAgentConfig` over this vocabulary, then probes it at the real desk boundary, before any replay.
