---
title: Prior art
description: Published work that Stately Agent's guards, traces, and improvement loop build on, and where each one differs.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Stately Agent's improvement loop has four stages: model the agent as a machine, observe runs as traces, propose a change, and compare the change against fixed scenarios. Each stage has published prior art. This page lists it and states where Stately Agent differs.

| Stage   | Prior art             | Stately Agent equivalent                                                                  |
| ------- | --------------------- | ----------------------------------------------------------------------------------------- |
| Model   | AgentSpec             | Guarded transitions and [guard enforcement](decisions.md#guard-enforcement)               |
| Observe | Process mining        | [`foldTraces`](evals.md#per-state-stats), [`traceCoverage`](evals.md#suite-coverage)      |
| Propose | AFlow                 | [The improvement loop](environment-and-policy.md#the-improvement-loop)                    |
| Compare | AFlow, process mining | Replay on train and held-out scenarios; [`verifyAgentConfig`](generate-machines.md) gates |

## AgentSpec

AgentSpec (Wang, Poskitt, and Sun; ICSE 2026; [arXiv:2503.18666](https://arxiv.org/abs/2503.18666)) is a domain-specific language for runtime rules on LLM agents. A rule has three parts:

- **Trigger:** the action or event the rule applies to.
- **Predicate:** a check against the agent's state and the action's arguments.
- **Enforcement:** block the action, ask a person to approve it, or run a fallback.

The rules sit between the agent and its tools and check each action before it runs.

An XState transition has the same shape: an event, a guard, and actions. In Stately Agent, a decision offers the model only events whose guards pass, and a person's approval is a resting state such as `reviewing`. See [Guard enforcement](decisions.md#guard-enforcement) and [Human in the loop](human-in-the-loop.md).

Where it differs:

- AgentSpec rules are checked per action, without a notion of where the run is. A machine's guards are scoped to the active state, so the same event can be legal in one state and absent in another.
- An event with no transition from the active state is not offered to the model at all, instead of being proposed and then blocked.

## Process mining

Process mining (van der Aalst et al., [Process Mining Manifesto](https://doi.org/10.1007/978-3-642-28108-2_19), 2011) comes from business process management. Its input is an event log of case ID, activity, and timestamp. It has four stages:

- **Discovery:** infer a process model from the log.
- **Conformance checking:** compare the log against an intended model and find deviations.
- **Enhancement:** annotate the model with frequencies, durations, and costs, then redesign it.
- **Monitoring:** repeat the above on production logs.

Stately Agent's trace tools map onto conformance checking and enhancement:

- [`traceCoverage`](evals.md#suite-coverage) and [`firstDivergence`](evals.md#where-failures-start) compare runs against the machine and against a reference run.
- [`foldTraces`](evals.md#per-state-stats) annotates each state with visits, failures, and withheld options across runs.

Where it differs:

- Process mining discovers the model from the log. Stately Agent starts from an authored machine and checks the log against it. Discovery fits when no model exists; checking fits when the invariants are already known.

## AFlow

AFlow (Zhang et al.; ICLR 2025; [arXiv:2410.10762](https://arxiv.org/abs/2410.10762)) represents an agent workflow as code: nodes that call an LLM, edges as control flow, and a small set of operators such as ensemble and review-and-revise. It runs Monte Carlo tree search over workflow variants. Each round, an LLM proposes a modification to the workflow code, the variant runs on a validation set, and the score feeds back into the search.

Stately Agent's [improvement loop](environment-and-policy.md#the-improvement-loop) is one AFlow round with a person in place of the tree search. A model proposes a change to the machine's structure instead of its prompt, and the change is scored on fixed scenarios.

Where it differs:

- AFlow optimizes a benchmark score. It has no invariants that a variant must preserve.
- In Stately Agent, a candidate must pass [`verifyAgentConfig`](generate-machines.md) and must have zero invariant violations on replay before it is promoted. The environment, its guards, and its invariants are outside what a candidate can change. See [What stays human](environment-and-policy.md#what-stays-human).

## Related

- [Environment and policy](environment-and-policy.md)
- [Evals](evals.md)
- [Coming from LangGraph](langgraph-comparison.md)
- [Scope and ecosystem boundaries](scope.md)
