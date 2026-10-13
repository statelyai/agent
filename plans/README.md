# Portable agent audit

[Full audit](portable-agent-audit.md), based on `4c39d3681ded940b2d824a10fa1e5266eaa17729` (`origin/next`, fetched September 7, 2026).

Core findings are recommendations, not implemented fixes. Three new policy examples and their tests/docs are implemented in this branch. Start with correctness findings 01–08 before API redesign. The report distinguishes reproductions, source-only findings, and design options.

# LangGraph gaps plan

[Full plan](langgraph-gaps.md), based on `b884c736` (`origin/next`, fetched October 13, 2026). Decisions taken with David on October 13–14, 2026.

Seven gaps versus LangGraph, each with current state, design, touches, effort, and risks, grouped into three PR-sized batches. Planning only; nothing is implemented. Sweep gap 6b is dropped as XState v6 semantics, 6f and a `forkThread` helper were dropped as redundant, and a bundled durable store is rejected in favor of conformance-tested recipes.
