import { describe, expect, test } from "vitest";
import { runAgent } from "../../src/index.js";
import type { AgentDecisionRequest, AgentUserInput, ChosenEvent } from "../../src/index.js";
import { todoMachine } from "./index.js";

// A scripted decide executor: pops one event per call off `events`. The
// `agent.plan` invoke calls it once per plan step (and again per retry).
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

// A scripted userInput executor: pops one command per prompt off `commands`.
function scriptedUserInput(commands: string[]) {
  const prompts: string[] = [];
  const userInput = async (input: AgentUserInput) => {
    prompts.push(input.prompt ?? "");
    const command = commands.shift();
    if (command === undefined) throw new Error("scriptedUserInput ran out of commands");
    return command;
  };
  return { userInput, prompts };
}

describe("todo-nl", () => {
  test("one command → several plan steps applied in order → the done move ends the plan", async () => {
    // A single command drives multiple events in one `agent.plan` invoke:
    // two adds, a toggle, then the built-in done move to end.
    const { decide, seen } = scriptedDecide([
      { type: "ADD_TODO", title: "pick up laundry" },
      { type: "ADD_TODO", title: "do groceries" },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "agent.plan.done" },
      { type: "QUIT" },
    ]);
    const { userInput } = scriptedUserInput([
      "add pick up laundry and do groceries, then mark laundry done",
      "quit",
    ]);

    const result = await runAgent(todoMachine, {
      input: { todos: [] },
      executors: { decide },
      userInput,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // Applied in order: both added, #1 toggled done.
    expect(result.output.todos).toEqual([
      { id: 1, title: "pick up laundry", done: true },
      { id: 2, title: "do groceries", done: false },
    ]);
    // The first plan step re-reads the live snapshot each iteration; later
    // steps carry the applied trail appended to the prompt.
    const planRequests = seen.filter((r) => r.prompt?.includes("User command:"));
    expect(planRequests[0]!.prompt).toContain("pick up laundry and do groceries");
    expect(planRequests[1]!.prompt).toContain("Events already applied in this plan");
  });

  test("a bad id mid-plan is rejected by guard, the plan retries the step with a good id", async () => {
    // First plan step uses a nonexistent id (99) → rejected-by-guard; the
    // plan retries the same step and the second attempt uses the real id (1).
    const { decide, seen } = scriptedDecide([
      { type: "TOGGLE_TODO", id: 99 },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "agent.plan.done" },
      { type: "QUIT" },
    ]);
    const { userInput } = scriptedUserInput(["mark the first one done", "quit"]);

    const result = await runAgent(todoMachine, {
      input: { todos: [{ id: 1, title: "write tests", done: false }] },
      executors: { decide },
      userInput,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.todos).toEqual([{ id: 1, title: "write tests", done: true }]);

    // The retry request carried a 'rejected-by-guard' attempt for id 99, seen
    // by the mock decide.
    const retryRequest = seen.find((request) => request.attempts.length > 0);
    expect(retryRequest?.attempts.at(-1)?.failure).toBe("rejected-by-guard");
  });

  test("QUIT applied mid-plan exits the state and produces final output", async () => {
    // QUIT exits `planning`, cancelling the plan invoke (its onDone never
    // runs); the machine moves straight to `done`.
    const { decide } = scriptedDecide([{ type: "QUIT" }]);
    const { userInput } = scriptedUserInput(["I'm done here"]);

    const result = await runAgent(todoMachine, {
      input: { todos: [{ id: 1, title: "existing", done: true }] },
      executors: { decide },
      userInput,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.todos).toEqual([{ id: 1, title: "existing", done: true }]);
  });
});
