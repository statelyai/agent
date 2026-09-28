import { describe, expect, test } from "vitest";
import { createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import type { AgentDecisionRequest, ChosenEvent } from "@statelyai/agent";
import { createMockModelExecutors } from "../mock-model.js";
import { idlePrompt, MAX_STEPS_PER_COMMAND, runTodoNlExample, todoMachine } from "./index.js";

/**
 * A scripted decide, keyed by the request name the `planning` invoke declares
 * (`planStep`): one entry per call, including retries.
 */
function scriptedDecide(events: ChosenEvent[]) {
  const seen: AgentDecisionRequest[] = [];
  const queue = [...events];
  const executors = createMockModelExecutors({
    decisions: {
      planStep: [
        (request) => {
          seen.push(request);
          const event = queue.shift();
          if (!event) throw new Error("scriptedDecide ran out of events");
          return event;
        },
      ],
    },
  });
  return { executors, seen };
}

describe("todo-nl", () => {
  test("one command → several decide steps applied in order → DONE ends the loop", async () => {
    // A single command drives multiple events through the decide loop:
    // two adds, a toggle, then DONE to leave the loop.
    const { executors, seen } = scriptedDecide([
      { type: "ADD_TODO", title: "pick up laundry" },
      { type: "ADD_TODO", title: "do groceries" },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "DONE" },
      { type: "QUIT" },
    ]);

    const output = await runTodoNlExample({
      input: { todos: [] },
      executors,
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
    const { executors, seen } = scriptedDecide([
      { type: "TOGGLE_TODO", id: 99 },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "DONE" },
      { type: "QUIT" },
    ]);

    const output = await runTodoNlExample({
      input: { todos: [{ id: 1, title: "write tests", done: false }] },
      executors,
      commands: ["mark the first one done", "quit"],
    });

    expect(output.todos).toEqual([{ id: 1, title: "write tests", done: true }]);

    // The retry request carried a 'rejected-by-guard' attempt for id 99, seen
    // by the mock decide.
    const retryRequest = seen.find((request) => request.attempts.length > 0);
    expect(retryRequest?.attempts.at(-1)?.failure).toBe("rejected-by-guard");
  });

  test("the loop is bounded: past the step budget only DONE and QUIT stay legal", async () => {
    // A model that keeps asking for one more ADD_TODO: the step past the
    // budget is rejected by guard, and the retry settles for DONE.
    const { executors, seen } = scriptedDecide([
      ...Array.from({ length: MAX_STEPS_PER_COMMAND + 1 }, (_, index) => ({
        type: "ADD_TODO" as const,
        title: `todo ${index + 1}`,
      })),
      { type: "DONE" },
      { type: "QUIT" },
    ]);

    const output = await runTodoNlExample({
      input: { todos: [] },
      executors,
      commands: ["add everything you can think of", "quit"],
    });

    // The budget stopped the loop; the extra ADD_TODO attempts were rejected.
    expect(output.todos).toHaveLength(MAX_STEPS_PER_COMMAND);
    const rejected = seen.flatMap((request) => request.attempts);
    expect(rejected.some((attempt) => attempt.failure === "rejected-by-guard")).toBe(true);
  });

  test("a group command walks every matching todo; the trail names what each step touched", async () => {
    // QA regression: "delete anything about groceries" deleted milk and kept
    // eggs. The prompt now says group commands hit EVERY semantic match, and
    // the applied trail carries titles so the next step sees milk is gone
    // and eggs is not.
    const { executors, seen } = scriptedDecide([
      { type: "DELETE_TODO", id: 1 },
      { type: "DELETE_TODO", id: 2 },
      { type: "DONE" },
      { type: "QUIT" },
    ]);

    const output = await runTodoNlExample({
      input: {
        todos: [
          { id: 1, title: "milk", done: true },
          { id: 2, title: "eggs", done: false },
          { id: 3, title: "call mom", done: false },
        ],
      },
      executors,
      commands: ["delete anything about groceries", "that's all, I'm done"],
    });

    expect(output.todos).toEqual([{ id: 3, title: "call mom", done: false }]);
    expect(seen[0]!.system).toContain("EVERY todo that matches by meaning");
    expect(seen[1]!.prompt).toContain('DELETE_TODO {"id":1} (milk)');
    expect(seen[2]!.prompt).toContain('DELETE_TODO {"id":2} (eggs)');
  });

  test("DONE and QUIT are told apart: 'I'm done' quits, 'mark X done' toggles", async () => {
    // QA regression: "that's all, I'm done" chose DONE, which loops back to
    // awaitingCommand. The system prompt maps finishing phrases to QUIT, and
    // each event's payload schema carries a description on its tool.
    const toolDescriptions: Record<string, unknown> = {};
    const executors = createMockModelExecutors({
      decisions: {
        planStep: (request, options) => {
          for (const tool of options.tools ?? []) {
            if (tool.type === "function") {
              toolDescriptions[tool.name] = (
                tool.inputSchema as { description?: string }
              ).description;
            }
          }
          expect(request.system).toContain("'I'm done'");
          return { type: "QUIT" };
        },
      },
    });

    const output = await runTodoNlExample({
      input: { todos: [] },
      executors,
      commands: ["that's all, I'm done"],
    });

    expect(output.todos).toEqual([]);
    const described = Object.entries(toolDescriptions);
    expect(described.find(([name]) => name.includes("QUIT"))?.[1]).toMatch(/I'm done/);
    expect(described.find(([name]) => name.includes("DONE"))?.[1]).toMatch(/Not for 'mark X done'/);
  });

  test("QUIT applied mid-loop exits the state and produces final output", async () => {
    // QUIT exits `planning`, cancelling the pending decide invoke; the machine
    // moves straight to `done`.
    const { executors } = scriptedDecide([{ type: "QUIT" }]);

    const output = await runTodoNlExample({
      input: { todos: [{ id: 1, title: "existing", done: true }] },
      executors,
      commands: ["I'm done here"],
    });

    expect(output.todos).toEqual([{ id: 1, title: "existing", done: true }]);
  });

  test("the machine settles idle in awaitingCommand with a context-computed prompt", async () => {
    const { executors } = scriptedDecide([]);

    // No commands: the very first run settles idle waiting for COMMAND.
    const result = await runToQuiescence(
      createAgentRuntime(todoMachine, {
        executors,
      }),
      {
        input: { todos: [{ id: 1, title: "existing", done: false }] },
      },
    );

    expect(result.status).toBe("idle");
    if (result.status !== "idle") throw new Error("expected idle");
    expect(result.snapshot.value).toBe("awaitingCommand");
    // The label function ran against the live context: counts plus the
    // numbered listing, so the waiting prompt shows the actual todos.
    expect(idlePrompt(result.snapshot)).toBe(
      "What should I do with your list? (1 todo, 1 open: 1. [ ] existing)",
    );

    // Resuming from the persisted snapshot with COMMAND enters the loop.
    const { executors: quitExecutors } = scriptedDecide([{ type: "QUIT" }]);
    const resumed = await runToQuiescence(
      createAgentRuntime(todoMachine, {
        executors: quitExecutors,
      }),
      {
        snapshot: result.persist(),
        event: { type: "COMMAND", text: "quit" },
      },
    );
    expect(resumed.status).toBe("done");
  });

  test("the idle prompt lists the todos after a command, with done/open markers", async () => {
    // Two adds and a toggle, then DONE settles idle again — the prompt now
    // carries the numbered listing, not just counts.
    const { executors } = scriptedDecide([
      { type: "ADD_TODO", title: "pick up laundry" },
      { type: "ADD_TODO", title: "do groceries" },
      { type: "TOGGLE_TODO", id: 1 },
      { type: "DONE" },
    ]);

    const started = await runToQuiescence(
      createAgentRuntime(todoMachine, {
        executors,
      }),
      {
        input: { todos: [] },
      },
    );
    if (started.status !== "idle") throw new Error("expected idle");
    expect(idlePrompt(started.snapshot)).toBe("What should I do with your list? (list is empty)");

    const result = await runToQuiescence(
      createAgentRuntime(todoMachine, {
        executors,
      }),
      {
        snapshot: started.persist(),
        event: { type: "COMMAND", text: "add pick up laundry and do groceries, laundry is done" },
      },
    );
    if (result.status !== "idle") throw new Error("expected idle");
    expect(idlePrompt(result.snapshot)).toBe(
      "What should I do with your list? " +
        "(2 todos, 1 open: 1. [x] pick up laundry · 2. [ ] do groceries)",
    );
  });
});
