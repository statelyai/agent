# Coming from LangGraph

Both libraries represent agent control flow explicitly. Stately Agent uses XState directly instead of introducing a second graph runtime.

| LangGraph concept | Stately Agent / XState |
| --- | --- |
| StateGraph | XState machine |
| Node | State, invoked actor, or action |
| Conditional edge | Guarded transition or decision event |
| Checkpointer | Native persisted XState snapshot stored by the host |
| Interrupt | Resting state that settles `runAgent` as idle |
| Stream events | `runAgentStream` plus XState inspection |
| Tool/model node | Named Agent request actor |
| Subgraph | Invoked child machine |

A machine can run with `runAgent`, an application-owned XState actor, a pure `initialTransition` / `transition` loop, or XState's durable runtime. The artifact does not change.

Stately Agent deliberately does not ship a checkpointer or event-log backend. Use the storage and interruption semantics of the framework hosting XState.
