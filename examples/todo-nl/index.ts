/**
 * Todo NL — natural language mapped onto a real app's machine events.
 *
 * A todo manager whose commands are free text. Each turn the model reads the
 * rendered todo list plus the user's raw command and chooses exactly one
 * currently-legal machine event (ADD_TODO / TOGGLE_TODO / DELETE_TODO /
 * NOTHING / QUIT). The model doesn't return a plan or a blob of JSON to
 * interpret later — it drives the same events a human clicking buttons would.
 *
 * Showcases:
 *   - Inline `agent.decide` invoke + `sendDecision()`: the model picks one
 *     legal event, typed against the machine's own event schemas.
 *   - An explicit `NOTHING` escape hatch: when a command maps to no action
 *     (chit-chat, already-done, unparseable), the model says so instead of
 *     inventing an event. This also terminates the multi-action loop below.
 *   - Guard-enforced honesty: TOGGLE_TODO / DELETE_TODO with an id that isn't
 *     in the list are illegal (v6 function-transitions returning `undefined`),
 *     so `resolveDecision`'s mode-3 `canTake` check rejects the choice
 *     (`failure: 'rejected-by-guard'`) and retries. The machine keeps the
 *     model from acting on ids that don't exist.
 *   - Machine-owned prompts: `agent.userInput` (tags: ['awaiting-user'])
 *     renders the current list so a host can just insert the machine and play.
 *
 * Multi-action caveat (motivates a future `agent.plan` API):
 *   A command like "add pick up laundry and do groceries" needs TWO events,
 *   but `decide` returns exactly one. We work around it by *looping*
 *   interpretation: after a non-NOTHING / non-QUIT event we re-enter
 *   `interpreting` with the SAME raw command plus a note of what was already
 *   applied, until the model chooses NOTHING. The already-applied trail lives
 *   in context (`pendingCommand` + `appliedEvents`) and is cleared on NOTHING
 *   or on new user input. This loop is awkward — a real `agent.plan` returning
 *   an ordered list of steps in one call would replace it.
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
import { createAgentSchemas, runAgent, sendDecision, setupAgent } from "../../src/index.js";

const todoSchema = z.object({
  id: z.number(),
  title: z.string(),
  done: z.boolean(),
});

type Todo = z.infer<typeof todoSchema>;

const appliedEventSchema = z.object({
  type: z.string(),
  summary: z.string(),
});

const models = {
  quick: openai("gpt-5.4-mini"),
} as const;

export const todoSchemas = createAgentSchemas({
  context: z.object({
    todos: z.array(todoSchema),
    nextId: z.number(),
    // The command currently being interpreted (may still contain more
    // actions), or null when we're waiting for fresh user input.
    pendingCommand: z.string().nullable(),
    // What we've already applied for `pendingCommand`, fed back to the model
    // so it doesn't repeat an action and knows when to stop (NOTHING).
    appliedEvents: z.array(appliedEventSchema),
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
    // Explicit "this command maps to no (further) action" signal. Ends the
    // multi-action interpretation loop.
    NOTHING: z.object({ reason: z.string() }),
    QUIT: z.object({}),
  },
});

const DECIDE_SYSTEM_PROMPT =
  "You manage a todo list by translating a user's natural-language command " +
  "into exactly one list operation event. Prefer the most direct mapping. " +
  "Only reference todo ids that appear in the current list. If the command " +
  "asks to quit/exit, choose QUIT. If the command maps to no (further) " +
  "action — small talk, already satisfied, or nothing left to do for it — " +
  "choose NOTHING with a short reason.";

function renderTodoList(todos: Todo[]): string {
  if (todos.length === 0) {
    return "(the todo list is empty)";
  }
  return todos.map((todo) => `  #${todo.id} [${todo.done ? "x" : " "}] ${todo.title}`).join("\n");
}

function renderInterpretPrompt(context: {
  todos: Todo[];
  pendingCommand: string | null;
  appliedEvents: { type: string; summary: string }[];
}): string {
  return [
    "Current todo list:",
    renderTodoList(context.todos),
    "",
    `User command: ${context.pendingCommand ?? ""}`,
    context.appliedEvents.length === 0
      ? "Nothing has been applied for this command yet."
      : [
          "Already applied for this command:",
          ...context.appliedEvents.map((applied) => `  - ${applied.summary}`),
          "If the command is now fully handled, choose NOTHING. Otherwise apply the next action.",
        ].join("\n"),
    "Choose the single next event for this command.",
  ].join("\n");
}

const agent = setupAgent({
  schemas: todoSchemas,
  models,
});

export const todoMachine = agent.createMachine({
  id: "todo-nl",
  context: ({ input }) => ({
    todos: input.todos,
    nextId: input.todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1,
    pendingCommand: null,
    appliedEvents: [],
    log: [],
  }),
  output: ({ context }) => ({
    todos: context.todos,
    log: context.log,
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
        // Fresh command: reset the multi-action trail before interpreting.
        onDone: ({ event }) => ({
          target: "interpreting",
          context: {
            pendingCommand: String(event.output ?? ""),
            appliedEvents: [],
          },
        }),
      },
    },

    interpreting: {
      invoke: {
        id: "chooseEvent",
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system: DECIDE_SYSTEM_PROMPT,
          prompt: renderInterpretPrompt(context),
          // Typo'd names are caught at compile time — allowedEvents is typed
          // against the machine's event-schema keys.
          allowedEvents: ["ADD_TODO", "TOGGLE_TODO", "DELETE_TODO", "NOTHING", "QUIT"] as const,
          maxRetries: 2,
        }),
        onDone: sendDecision(),
        // Model couldn't produce a legal event (e.g. kept choosing a bad id).
        // Treat it as "nothing to do" and go back to the user.
        onError: {
          target: "awaitingCommand",
          context: ({ context }) => ({
            log: [...context.log, "(could not interpret command)"],
            pendingCommand: null,
            appliedEvents: [],
          }),
        },
      },
      on: {
        // Each successful action targets `applying` (not `interpreting`
        // directly): a self-transition back to `interpreting` would keep the
        // same `agent.decide` invoke alive instead of restarting it, so the
        // loop would stall after one event. `applying` is a transient state
        // whose `always` bounces straight back into `interpreting`, forcing a
        // fresh decide invoke with the updated applied trail.
        ADD_TODO: ({ context, event }) => ({
          target: "applying",
          context: {
            todos: [...context.todos, { id: context.nextId, title: event.title, done: false }],
            nextId: context.nextId + 1,
            appliedEvents: [
              ...context.appliedEvents,
              { type: "ADD_TODO", summary: `added "${event.title}" as #${context.nextId}` },
            ],
            log: [...context.log, `added #${context.nextId}: ${event.title}`],
          },
        }),

        // Guard: only togglable if the id exists. Returning `undefined` makes
        // the transition illegal, so resolveDecision's canTake check rejects
        // a bad id (failure: 'rejected-by-guard') and retries.
        TOGGLE_TODO: ({ context, event }) => {
          const target = context.todos.find((todo) => todo.id === event.id);
          if (!target) return undefined;
          return {
            target: "applying",
            context: {
              todos: context.todos.map((todo) =>
                todo.id === event.id ? { ...todo, done: !todo.done } : todo,
              ),
              appliedEvents: [
                ...context.appliedEvents,
                {
                  type: "TOGGLE_TODO",
                  summary: `toggled #${event.id} to ${target.done ? "not done" : "done"}`,
                },
              ],
              log: [...context.log, `toggled #${event.id}`],
            },
          };
        },

        // Guard: only deletable if the id exists.
        DELETE_TODO: ({ context, event }) => {
          const target = context.todos.find((todo) => todo.id === event.id);
          if (!target) return undefined;
          return {
            target: "applying",
            context: {
              todos: context.todos.filter((todo) => todo.id !== event.id),
              appliedEvents: [
                ...context.appliedEvents,
                { type: "DELETE_TODO", summary: `deleted #${event.id} ("${target.title}")` },
              ],
              log: [...context.log, `deleted #${event.id}`],
            },
          };
        },

        // Command fully handled (or maps to nothing): clear the trail and
        // wait for the next command.
        NOTHING: ({ context, event }) => ({
          target: "awaitingCommand",
          context: {
            pendingCommand: null,
            appliedEvents: [],
            log:
              context.appliedEvents.length === 0
                ? [...context.log, `(no action: ${event.reason})`]
                : context.log,
          },
        }),

        QUIT: {
          target: "done",
        },
      },
    },

    // Transient: exists only to force a fresh `interpreting` entry (and thus a
    // fresh `agent.decide` invoke) after each applied action. See the `on`
    // handlers above.
    applying: {
      always: { target: "interpreting" },
    },

    done: {
      type: "final",
    },
  },
});

const executors = createAiSdkExecutors({ models });

async function promptCommand(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${prompt}\n> `);
  } finally {
    rl.close();
  }
}

export async function main() {
  const result = await runAgent(todoMachine, {
    input: { todos: [] },
    ...executors,
    userInput: async ({ prompt }) => promptCommand(prompt ?? ">"),
  });

  if (result.status !== "done") {
    throw new Error(`Todo NL did not complete: ${result.status}`);
  }

  console.log("\nFinal todo list:");
  console.log(renderTodoList(result.output.todos));
  console.log(`\n${result.output.log.length} action(s) taken.`);
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void main();
}
