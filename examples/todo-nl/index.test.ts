import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentDecisionRequest, ChosenEvent } from "@statelyai/agent";
import { idlePrompt, runTodoNlExample, todoMachine } from "./index.js";

// A scripted decide executor: pops one event per call off `events`. The
// `planning` loop calls it once per step (and again per retry).
function scriptedDecide(events: ChosenEvent[]) {
  const seen: AgentDecisionRequest[] = [];
  const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
    seen.push(request);
    const event = events.shift();
    if (!event) throw new Error("scriptedDecide ran out of events");
    return { event };
  };
  return { decide, seen };
}

describe("todo-nl", () => {
  test("one command → several decide steps applied in order → DONE ends the loop", async () => {
    // A single command drives multiple events through the decide loop:
    // two adds, a toggle, then DONE to leave the loop.
    const { decide, seen } = scriptedDecide([
      { type: "ADD_TODO", title: "pick up laundry" },
      { type: "ADD_TODO", title: "do groceries" },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "DONE" },
      { type: "QUIT" },
    ]);

    const output = await runTodoNlExample({
      input: { todos: [] },
      decide,
      commands: ["add pick up laundry and do groceries, then mark laundry done", "quit"],
    });

    // Applied in order: both added, #1 toggled done.
    expect(output.todos).toEqual([
      { id: 1, title: "pick up laundry", done: true },
      { id: 2, title: "do groceries", done: false },
    ]);
    // Each loop step re-reads the live snapshot; later steps carry the applied
    // trail from context in the prompt.
    const stepRequests = seen.filter((r) => r.prompt?.includes("User command:"));
    expect(stepRequests[0]!.prompt).toContain("pick up laundry and do groceries");
    expect(stepRequests[1]!.prompt).toContain("Events already applied for this command");
  });

  test("a bad id mid-loop is rejected by guard, the step retries with a good id", async () => {
    // The first decide step uses a nonexistent id (99) → rejected-by-guard; the
    // step retries and the second attempt uses the real id (1).
    const { decide, seen } = scriptedDecide([
      { type: "TOGGLE_TODO", id: 99 },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "DONE" },
      { type: "QUIT" },
    ]);

    const output = await runTodoNlExample({
      input: { todos: [{ id: 1, title: "write tests", done: false }] },
      decide,
      commands: ["mark the first one done", "quit"],
    });

    expect(output.todos).toEqual([{ id: 1, title: "write tests", done: true }]);

    // The retry request carried a 'rejected-by-guard' attempt for id 99, seen
    // by the mock decide.
    const retryRequest = seen.find((request) => request.attempts.length > 0);
    expect(retryRequest?.attempts.at(-1)?.failure).toBe("rejected-by-guard");
  });

  test("QUIT applied mid-loop exits the state and produces final output", async () => {
    // QUIT exits `planning`, cancelling the pending decide invoke; the machine
    // moves straight to `done`.
    const { decide } = scriptedDecide([{ type: "QUIT" }]);

    const output = await runTodoNlExample({
      input: { todos: [{ id: 1, title: "existing", done: true }] },
      decide,
      commands: ["I'm done here"],
    });

    expect(output.todos).toEqual([{ id: 1, title: "existing", done: true }]);
  });

  test("the machine settles idle in awaitingCommand with an interpolated prompt", async () => {
    const { decide } = scriptedDecide([]);

    // No commands: the very first run settles idle waiting for COMMAND.
    const result = await runAgent(todoMachine, {
      input: { todos: [{ id: 1, title: "existing", done: false }] },
      executors: { decide },
    });

    expect(result.status).toBe("idle");
    if (result.status !== "idle") throw new Error("expected idle");
    expect(result.snapshot.value).toBe("awaitingCommand");
    // `{todosSummary}` resolved against the live context: counts plus the
    // numbered listing, so the waiting prompt shows the actual todos.
    expect(idlePrompt(result.snapshot)).toBe(
      "What should I do with your list? (1 todo, 1 open: 1. [ ] existing)",
    );

    // Resuming from the persisted snapshot with COMMAND enters the loop.
    const { decide: decide2 } = scriptedDecide([{ type: "QUIT" }]);
    const resumed = await runAgent(todoMachine, {
      snapshot: result.persist(),
      event: { type: "COMMAND", text: "quit" },
      executors: { decide: decide2 },
    });
    expect(resumed.status).toBe("done");
  });

  test("the idle prompt lists the todos after a command, with done/open markers", async () => {
    // Two adds and a toggle, then DONE settles idle again — the prompt now
    // carries the numbered listing, not just counts.
    const { decide } = scriptedDecide([
      { type: "ADD_TODO", title: "pick up laundry" },
      { type: "ADD_TODO", title: "do groceries" },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "DONE" },
    ]);

    const started = await runAgent(todoMachine, {
      input: { todos: [] },
      executors: { decide },
    });
    if (started.status !== "idle") throw new Error("expected idle");
    expect(idlePrompt(started.snapshot)).toBe("What should I do with your list? (list is empty)");

    const result = await runAgent(todoMachine, {
      snapshot: started.persist(),
      event: { type: "COMMAND", text: "add pick up laundry and do groceries, laundry is done" },
      executors: { decide },
    });
    if (result.status !== "idle") throw new Error("expected idle");
    expect(idlePrompt(result.snapshot)).toBe(
      "What should I do with your list? " +
        "(2 todos, 1 open: 1. [x] pick up laundry · 2. [ ] do groceries)",
    );
  });
});
