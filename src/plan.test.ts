import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAgentSchemas, runAgent, setupAgent } from "./index.js";
import type { AgentDecisionExecutor, AgentDecisionRequest, ChosenEvent } from "./index.js";

// A todo-list machine managed by one `agent.plan` invoke: the model applies
// any number of legal events, then chooses NOTHING (stopOn) to end the plan.
function createTodoAgent() {
  const agent = setupAgent({
    schemas: createAgentSchemas({
      context: z.object({
        todos: z.array(z.object({ id: z.string(), title: z.string(), done: z.boolean() })),
        log: z.array(z.string()),
      }),
      output: z.object({ titles: z.array(z.string()), log: z.array(z.string()) }),
      events: {
        ADD_TODO: z.object({ title: z.string() }),
        TOGGLE_TODO: z.object({ id: z.string() }),
        NOTHING: z.object({}),
        QUIT: z.object({}),
      },
    }),
  });

  const machine = agent.createMachine({
    context: () => ({ todos: [], log: [] }),
    initial: "planning",
    states: {
      planning: {
        invoke: {
          src: "agent.plan",
          input: () => ({
            model: "quick",
            prompt: "Manage the todo list.",
            allowedEvents: ["ADD_TODO", "TOGGLE_TODO", "NOTHING", "QUIT"] as const,
            stopOn: ["NOTHING"] as const,
            maxSteps: 5,
          }),
          onDone: ({ context, output }) => ({
            target: "done",
            context: {
              log: [...context.log, `stopped:${output.stopped}`, `steps:${output.steps.length}`],
            },
          }),
        },
        on: {
          ADD_TODO: ({ context, event }) => ({
            context: {
              todos: [
                ...context.todos,
                { id: `t${context.todos.length + 1}`, title: event.title, done: false },
              ],
            },
          }),
          // Guard: unknown ids are rejected (transition not taken).
          TOGGLE_TODO: ({ context, event }) =>
            context.todos.some((todo) => todo.id === event.id)
              ? {
                  context: {
                    todos: context.todos.map((todo) =>
                      todo.id === event.id ? { ...todo, done: !todo.done } : todo,
                    ),
                  },
                }
              : undefined,
          NOTHING: {},
          QUIT: { target: "done" },
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({
          titles: context.todos.map((todo) => todo.title),
          log: context.log,
        }),
      },
    },
  });

  return machine;
}

// Scripted decide executor that records every per-attempt request.
function createScriptedDecide(script: ChosenEvent[]) {
  const requests: AgentDecisionRequest[] = [];
  let index = 0;
  const decide: AgentDecisionExecutor = async (request) => {
    requests.push(request);
    const event = script[index++];
    if (!event) {
      throw new Error("scripted decide ran out of events");
    }
    return { event };
  };
  return { decide, requests };
}

describe("agent.plan (multi-event decision)", () => {
  test("applies events in order and stops on a stopOn event", async () => {
    const { decide, requests } = createScriptedDecide([
      { type: "ADD_TODO", title: "buy milk" },
      { type: "ADD_TODO", title: "buy eggs" },
      { type: "TOGGLE_TODO", id: "t1" },
      { type: "NOTHING" },
    ]);

    const result = await runAgent(createTodoAgent(), { decide });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.titles).toEqual(["buy milk", "buy eggs"]);
    expect(result.output.log).toEqual(["stopped:stop-event", "steps:4"]);
    // Each step re-reads the live snapshot: candidates always reflect the
    // machine, and the applied trail is appended to the prompt.
    expect(requests).toHaveLength(4);
    expect(requests[0]!.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["ADD_TODO", "TOGGLE_TODO", "NOTHING", "QUIT"]),
    );
    expect(requests[0]!.prompt).toBe("Manage the todo list.");
    expect(requests[1]!.prompt).toContain("Events already applied in this plan");
    expect(requests[1]!.prompt).toContain('"buy milk"');
  });

  test("guard-rejected steps retry with rejected-by-guard feedback", async () => {
    const seen: Pick<AgentDecisionRequest, "id" | "attempts">[] = [];
    let call = 0;
    const decide: AgentDecisionExecutor = async (request) => {
      seen.push({ id: request.id, attempts: request.attempts });
      call += 1;
      if (call === 1) return { event: { type: "TOGGLE_TODO", id: "missing" } };
      if (call === 2) return { event: { type: "ADD_TODO", title: "recovered" } };
      return { event: { type: "NOTHING" } };
    };

    const result = await runAgent(createTodoAgent(), { decide });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.titles).toEqual(["recovered"]);
    // Second call is the retry for the same step, carrying the failure.
    expect(seen[1]!.attempts.at(-1)?.failure).toBe("rejected-by-guard");
    // The plan applied 2 events (ADD_TODO, NOTHING); the rejected toggle was
    // never sent.
    expect(result.output.log).toEqual(["stopped:stop-event", "steps:2"]);
  });

  test("maxSteps caps the plan", async () => {
    const { decide } = createScriptedDecide([
      { type: "ADD_TODO", title: "1" },
      { type: "ADD_TODO", title: "2" },
      { type: "ADD_TODO", title: "3" },
      { type: "ADD_TODO", title: "4" },
      { type: "ADD_TODO", title: "5" },
    ]);

    const result = await runAgent(createTodoAgent(), { decide });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.titles).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.output.log).toEqual(["stopped:max-steps", "steps:5"]);
  });

  test("an applied event that exits the state ends the plan (invoke canceled)", async () => {
    const { decide } = createScriptedDecide([
      { type: "ADD_TODO", title: "last one" },
      { type: "QUIT" },
    ]);

    const result = await runAgent(createTodoAgent(), { decide });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.titles).toEqual(["last one"]);
    // QUIT exited `planning`, so the invoke's onDone never ran: no log entry.
    expect(result.output.log).toEqual([]);
  });

  test("without a decide executor, binding fails fast", async () => {
    await expect(runAgent(createTodoAgent(), {})).rejects.toThrow(
      /invokes plan source 'agent\.plan' but no 'decide' executor/,
    );
  });
});
