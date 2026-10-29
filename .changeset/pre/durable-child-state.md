---
"@statelyai/agent": patch
---

An invoked child machine keeps its state across a resume. The runtime journals what each child machine processes as an entry with a new optional `actorPath`, and `replay` steps that child through those entries, so a long-lived child no longer restarts from its initial state on every turn, and a `persist()` snapshot holding its progress resumes instead of being rejected as diverged. A nested machine's `machineVersion` also no longer changes once one of its transitions has run. A child step that throws no longer makes `replay` throw.
