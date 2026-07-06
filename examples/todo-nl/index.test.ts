import { describe, expect, test } from "vitest";
import { runAgent } from "../../src/index.js";
import type { AgentDecisionRequest, AgentUserInput, ChosenEvent } from "../../src/index.js";
import { todoMachine } from "./index.js";

// A scripted decide executor: pops one event per call off `events`.
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
  test("one command → two ADD_TODO events then NOTHING → both todos present", async () => {
    const { decide } = scriptedDecide([
      { type: "ADD_TODO", title: "pick up laundry" },
      { type: "ADD_TODO", title: "do groceries" },
      { type: "NOTHING", reason: "command fully handled" },
      { type: "QUIT" },
    ]);
    const { userInput } = scriptedUserInput(["add pick up laundry and do groceries", "quit"]);

    const result = await runAgent(todoMachine, {
      input: { todos: [] },
      generateText: async () => ({ output: "" }),
      decide,
      userInput,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.todos).toEqual([
      { id: 1, title: "pick up laundry", done: false },
      { id: 2, title: "do groceries", done: false },
    ]);
  });

  test("TOGGLE_TODO with a bad id is rejected by guard, retry with good id toggles it", async () => {
    // First decide attempt uses a nonexistent id (99) → rejected-by-guard;
    // resolveDecision retries and the second attempt uses the real id (1).
    const { decide, seen } = scriptedDecide([
      { type: "TOGGLE_TODO", id: 99 },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "NOTHING", reason: "done" },
      { type: "QUIT" },
    ]);
    const { userInput } = scriptedUserInput(["mark the first one done", "quit"]);

    const result = await runAgent(todoMachine, {
      input: { todos: [{ id: 1, title: "write tests", done: false }] },
      generateText: async () => ({ output: "" }),
      decide,
      userInput,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.todos).toEqual([{ id: 1, title: "write tests", done: true }]);

    // The retry request carried a 'rejected-by-guard' attempt for id 99.
    const retryRequest = seen.find((request) => request.attempts.length > 0);
    expect(retryRequest?.attempts.at(-1)?.failure).toBe("rejected-by-guard");
  });

  test("QUIT produces final output with the current todos", async () => {
    const { decide } = scriptedDecide([{ type: "QUIT" }]);
    const { userInput } = scriptedUserInput(["I'm done here"]);

    const result = await runAgent(todoMachine, {
      input: { todos: [{ id: 1, title: "existing", done: true }] },
      generateText: async () => ({ output: "" }),
      decide,
      userInput,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.todos).toEqual([{ id: 1, title: "existing", done: true }]);
  });
});
