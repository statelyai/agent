/**
 * Todo NL — natural language mapped onto a real app's machine events.
 *
 * A todo manager whose commands are free text. One `agent.plan` invoke reads
 * the user's raw command and drives any number of currently-legal machine
 * events (ADD_TODO / TOGGLE_TODO / DELETE_TODO / QUIT), one at a time, against
 * the live snapshot — the same events a human clicking buttons would send.
 * "add pick up laundry and do groceries" becomes two ADD_TODO events in one
 * plan; the model chooses the built-in done move when the command is fully
 * handled, which ends the plan without touching the machine.
 *
 * Showcases:
 *   - The `agent.plan` builtin: a multi-event decision. Each step re-reads the
 *     live snapshot (candidates always reflect the real machine), the applied
 *     trail is appended to the prompt automatically, and the loop ends on the
 *     built-in done move, at `maxSteps`, or when an applied event exits the
 *     state.
 *   - The built-in done move: every plan step is offered an `agent.plan.done`
 *     option, so when a command maps to no (further) action (chit-chat,
 *     already-done, unparseable), the model chooses it instead of inventing an
 *     event, and the plan ends. No no-op sentinel event on the machine.
 *   - Guard-enforced honesty: TOGGLE_TODO / DELETE_TODO with an id that isn't
 *     in the list are illegal (v6 function-transitions returning `undefined`),
 *     so the plan step is rejected (`failure: 'rejected-by-guard'`) and retried
 *     with that feedback. The machine keeps the model from acting on ids that
 *     don't exist.
 *   - QUIT exiting the `planning` state ends the plan naturally: xstate cancels
 *     the invoke, so no onDone runs — the machine just moves to `done`.
 *   - Machine-owned prompts: `agent.userInput` (tags: ['awaiting-user'])
 *     renders the current list so a host can just insert the machine and play.
 *
 * Companion: `imperative.ts` builds the SAME app with no @statelyai/agent
 * import (raw `ai` generateObject + a while loop) so the two can be compared
 * side by side.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/todo-nl/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { promptLine } from "../helpers/cli.js";
import { createAgentSchemas, runAgent, setupAgent } from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

const todoSchema = z.object({
  id: z.number(),
  title: z.string(),
  done: z.boolean(),
});

type Todo = z.infer<typeof todoSchema>;

const models = {
  quick: openai("gpt-5.4-mini"),
} as const;

export const todoSchemas = createAgentSchemas({
  context: z.object({
    todos: z.array(todoSchema),
    nextId: z.number(),
    // The command being planned, or null when waiting for fresh user input.
    pendingCommand: z.string().nullable(),
    // Human-readable trail of everything that happened, for output/logging.
    log: z.array(z.string()),
  }),
  input: z.object({
    todos: z.array(todoSchema).default([]),
  }),
  output: z.object({
    todos: z.array(todoSchema),
    log: z.array(z.string()),
  }),
  events: {
    ADD_TODO: z.object({ title: z.string() }),
    TOGGLE_TODO: z.object({ id: z.number() }),
    DELETE_TODO: z.object({ id: z.number() }),
    QUIT: z.object({}),
  },
});

const PLAN_SYSTEM_PROMPT =
  "You manage a todo list by translating a user's natural-language command " +
  "into a sequence of list operation events. One command may need several " +
  "events (e.g. 'add X and Y' → two ADD_TODO). Apply them one at a time, in " +
  "order. Prefer the most direct mapping. Only reference todo ids that appear " +
  "in the current list. If the command asks to quit/exit, choose QUIT. When " +
  "the command is fully handled — or maps to no action (small talk, already " +
  "satisfied) — choose the done move to end.";

function renderTodoList(todos: Todo[]): string {
  if (todos.length === 0) {
    return "(the todo list is empty)";
  }
  return todos.map((todo) => `  #${todo.id} [${todo.done ? "x" : " "}] ${todo.title}`).join("\n");
}

const agentSetup = setupAgent({
  schemas: todoSchemas,
  models,
});

export const todoMachine = agentSetup.createMachine({
  id: "todo-nl",
  context: ({ input }) => ({
    todos: input.todos,
    nextId: input.todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1,
    pendingCommand: null,
    log: [],
  }),
  initial: "awaitingCommand",
  states: {
    awaitingCommand: {
      tags: ["awaiting-user"],
      invoke: {
        src: "agent.userInput",
        input: ({ context }) => ({
          prompt: [
            "Current todo list:",
            renderTodoList(context.todos),
            "What would you like to do? (natural language, or 'quit')",
          ].join("\n"),
        }),
        onDone: ({ event }) => ({
          target: "planning",
          context: {
            pendingCommand: String(event.output ?? ""),
          },
        }),
      },
    },

    // One `agent.plan` invoke drains the whole command: it iterates `decide`
    // against the live snapshot, applying legal events in order until the model
    // chooses the built-in done move. A multi-action command like "add X and Y"
    // produces several ADD_TODO steps in one plan — no hand-rolled
    // interpret/apply loop, no applied-trail context bookkeeping (the plan
    // appends the applied trail to the prompt for us).
    planning: {
      invoke: {
        src: "agent.plan",
        input: ({ context }) => ({
          model: "quick",
          system: PLAN_SYSTEM_PROMPT,
          prompt: [
            "Current todo list:",
            renderTodoList(context.todos),
            "",
            `User command: ${context.pendingCommand ?? ""}`,
          ].join("\n"),
          // Typo'd names are caught at compile time — allowedEvents is typed
          // against the machine's event-schema keys.
          allowedEvents: ["ADD_TODO", "TOGGLE_TODO", "DELETE_TODO", "QUIT"] as const,
          // The plan ends via the built-in done move (offered automatically),
          // at maxSteps, or when QUIT exits the state (below) and cancels the
          // invoke. No `stopOn` sentinel needed.
          maxSteps: 8,
        }),
        // The plan finished on the done move (or maxSteps): back to the user. If
        // QUIT was applied, the state already exited and this onDone never ran.
        onDone: {
          target: "awaitingCommand",
          context: { pendingCommand: null },
        },
        // The plan couldn't produce a legal event (e.g. kept choosing a bad
        // id). Treat it as "nothing to do" and go back to the user.
        onError: {
          target: "awaitingCommand",
          context: ({ context }) => ({
            log: [...context.log, "(could not interpret command)"],
            pendingCommand: null,
          }),
        },
      },
      on: {
        ADD_TODO: ({ context, event }) => ({
          context: {
            todos: [...context.todos, { id: context.nextId, title: event.title, done: false }],
            nextId: context.nextId + 1,
            log: [...context.log, `added #${context.nextId}: ${event.title}`],
          },
        }),

        // Guard: only togglable if the id exists. Returning `undefined` makes
        // the transition illegal, so the plan step is rejected
        // (failure: 'rejected-by-guard') and retried.
        TOGGLE_TODO: ({ context, event }) => {
          const target = context.todos.find((todo) => todo.id === event.id);
          if (!target) return undefined;
          return {
            context: {
              todos: context.todos.map((todo) =>
                todo.id === event.id ? { ...todo, done: !todo.done } : todo,
              ),
              log: [...context.log, `toggled #${event.id}`],
            },
          };
        },

        // Guard: only deletable if the id exists.
        DELETE_TODO: ({ context, event }) => {
          const target = context.todos.find((todo) => todo.id === event.id);
          if (!target) return undefined;
          return {
            context: {
              todos: context.todos.filter((todo) => todo.id !== event.id),
              log: [...context.log, `deleted #${event.id}`],
            },
          };
        },

        QUIT: {
          target: "done",
        },
      },
    },

    done: {
      type: "final",
      output: ({ context }) => ({
        todos: context.todos,
        log: context.log,
      }),
    },
  },
});

const executors = createAiSdkExecutors({ models });

export async function main() {
  const result = await runAgent(todoMachine, {
    input: { todos: [] },
    ...executors,
    userInput: async ({ prompt }) => promptLine(`${prompt ?? ">"}\n> `),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Todo NL did not complete: ${result.status}`);
  }

  console.log("\nFinal todo list:");
  console.log(renderTodoList(result.output.todos));
  console.log(`\n${result.output.log.length} action(s) taken.`);
}

runExampleMain(import.meta.url, main);
