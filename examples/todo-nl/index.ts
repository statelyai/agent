/**
 * Todo NL — multi-event commands via a decide loop, driven by an idle state.
 *
 * A todo manager whose commands are free text. The machine settles idle in
 * `awaitingCommand` (no invoke) and a host resumes it with `COMMAND { text }`.
 * From there the `planning` state invokes `agent.decide` once per step: the
 * model picks ONE currently-legal machine event (ADD_TODO / TOGGLE_TODO /
 * DELETE_TODO / QUIT / DONE) against the live snapshot, the machine applies it
 * and re-enters `planning` for the next step. "add pick up laundry and do
 * groceries" becomes two ADD_TODO events across two loop iterations; `DONE`
 * exits the loop back to `awaitingCommand`.
 *
 * Showcases:
 *   - Human input as a gated machine event. `awaitingCommand` has no invoke, so
 *     the run settles `idle` there. `meta.interaction` declares the label and
 *     `textEvent: "COMMAND"`, so a host routes free chat text into the machine
 *     and resumes with `runAgent(machine, { snapshot: result.persist(),
 *     event })`. Nothing needs to answer a prompt callback. The default
 *     structural idle rule recognizes the state's external event handler.
 *   - Labels computed from context at render time: the interaction label is a
 *     function of the snapshot context, so the idle prompt lists the actual
 *     todos (numbered, with done/open markers) without a rendered string
 *     living in — and being kept in sync in — context.
 *   - A multi-event command as an explicit loop in the statechart: the loop is
 *     a self-transition on `planning`, so every step, its exit condition, and
 *     the applied trail are visible in the machine — not hidden in a builtin.
 *   - An explicit done option: `DONE` is a real machine event the model may
 *     choose when the command is fully handled (chit-chat, already satisfied,
 *     unparseable), instead of inventing an action. It targets
 *     `awaitingCommand`, which ends the loop and settles idle again.
 *   - The applied trail in context: `applied` is appended to each step's
 *     prompt, so the model sees what it already did and does not repeat itself.
 *   - Guard-enforced honesty: TOGGLE_TODO / DELETE_TODO with an id that isn't
 *     in the list are illegal (v6 function-transitions returning `undefined`),
 *     so the step is rejected (`failure: 'rejected-by-guard'`) and retried with
 *     that feedback. The machine keeps the model from acting on ids that
 *     don't exist.
 *   - A bounded loop: at most `MAX_STEPS_PER_COMMAND` events are applied per
 *     command. Past that the list-changing events are illegal, so `DONE` (or
 *     QUIT) is the only legal choice and the loop always terminates.
 *   - QUIT exits the `planning` state straight to `done`.
 *
 * Companion: `imperative.ts` builds the SAME app with no @statelyai/agent
 * import (raw `ai` generateObject + a while loop) so the two can be compared
 * side by side.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/todo-nl/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import type { SnapshotFrom } from "xstate";

const todoSchema = z.object({
  id: z.number(),
  title: z.string(),
  done: z.boolean(),
});

type Todo = z.infer<typeof todoSchema>;

const models = defineModels({
  quick: openai("gpt-5.4-mini"),
});

/** Events one command may apply before only DONE / QUIT stay legal. */
export const MAX_STEPS_PER_COMMAND = 6;

export const todoSchemas = createAgentSchemas({
  meta: interactionMetaSchema,
  context: z.object({
    todos: z.array(todoSchema),
    nextId: z.number(),
    // The command being planned, or null when waiting for fresh user input.
    pendingCommand: z.string().nullable(),
    // The events applied so far for the current command, in order — the trail
    // the next decide step sees so it does not repeat itself, and the step
    // counter the loop bound is checked against.
    applied: z.array(z.string()),
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
    // The human's free-text command. The host sends this to the idle state.
    COMMAND: z.object({ text: z.string() }),
    ADD_TODO: z.object({ title: z.string() }),
    TOGGLE_TODO: z.object({ id: z.number() }),
    DELETE_TODO: z.object({ id: z.number() }),
    QUIT: z.object({}),
    // The explicit "nothing (more) to do" move that ends the loop.
    DONE: z.object({}),
  },
});

function renderTodoList(todos: Todo[]): string {
  if (todos.length === 0) {
    return "(the todo list is empty)";
  }
  return todos.map((todo) => `  #${todo.id} [${todo.done ? "x" : " "}] ${todo.title}`).join("\n");
}

/**
 * The list as shown in the idle prompt: counts plus the numbered titles with
 * done/open markers, so the waiting prompt shows the actual todos. Interaction
 * labels collapse whitespace, so the listing stays on one line:
 * `2 todos, 1 open: 1. [x] milk · 2. [ ] eggs`.
 */
export function summarizeTodos(todos: Todo[]): string {
  if (todos.length === 0) return "list is empty";
  const open = todos.filter((todo) => !todo.done).length;
  const list = todos
    .map((todo, index) => `${index + 1}. [${todo.done ? "x" : " "}] ${todo.title}`)
    .join(" · ");
  return `${todos.length} todo${todos.length === 1 ? "" : "s"}, ${open} open: ${list}`;
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
    applied: [],
    log: [],
  }),
  initial: "awaitingCommand",
  states: {
    // No invoke: the run settles idle here and a host resumes it with
    // `COMMAND { text }`. `meta.interaction.textEvent` tells the host to route
    // whatever the user types into that event.
    awaitingCommand: {
      tags: ["waiting"],
      meta: {
        interaction: {
          // Computed from the live context when the label is shown, so no
          // rendered listing has to be kept in sync inside context.
          label: ({ context }: { context: { todos: Todo[] } }) =>
            `What should I do with your list? (${summarizeTodos(context.todos)})`,
          textEvent: "COMMAND",
          events: { COMMAND: { label: "Send", style: "primary" } },
        },
      },
      on: {
        COMMAND: ({ event }) => ({
          target: "planning",
          context: { pendingCommand: event.text, applied: [] },
        }),
      },
    },

    // The decide loop. Each entry to `planning` invokes `agent.decide` for ONE
    // legal event; applying it passes through `applying` and back into
    // `planning`, which starts the next step. A multi-action command like
    // "add X and Y" walks the loop twice. `DONE` (or QUIT) leaves the loop — the whole control flow is
    // in the statechart, not inside a builtin.
    planning: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system:
            "You manage a todo list by translating a user's natural-language command " +
            "into list operation events, ONE event per turn. One command may need " +
            "several events (e.g. 'add X and Y' → two ADD_TODO), applied in order over " +
            "successive turns. Prefer the most direct mapping. Only reference todo ids " +
            "that appear in the current list. If the command asks to quit/exit, choose " +
            "QUIT. When the command is fully handled — or maps to no action (small talk, " +
            "already satisfied) — choose DONE.",
          prompt: [
            "Current todo list:",
            renderTodoList(context.todos),
            "",
            `User command: ${context.pendingCommand ?? ""}`,
            ...(context.applied.length === 0
              ? []
              : [
                  "",
                  "Events already applied for this command, in order:",
                  ...context.applied,
                  "Continue from here; do not repeat applied events.",
                ]),
          ].join("\n"),
          name: "planStep",
          allowedEvents: ["ADD_TODO", "TOGGLE_TODO", "DELETE_TODO", "QUIT", "DONE"] as const,
        }),
        // The decision couldn't produce a legal event (e.g. kept choosing a bad
        // id). Treat it as "nothing to do" and go back to the user.
        onError: {
          target: "awaitingCommand",
          context: ({ context }) => ({
            log: [...context.log, "(could not interpret command)"],
            pendingCommand: null,
            applied: [],
          }),
        },
      },
      on: {
        // Each applied event goes to `applying`, which loops straight back to
        // `planning` — that re-entry starts the next decide step.
        ADD_TODO: ({ context, event }) => {
          if (context.applied.length >= MAX_STEPS_PER_COMMAND) return undefined;
          const todos = [...context.todos, { id: context.nextId, title: event.title, done: false }];
          return {
            target: "applying" as const,
            context: {
              todos,
              nextId: context.nextId + 1,
              applied: [...context.applied, `ADD_TODO ${JSON.stringify({ title: event.title })}`],
              log: [...context.log, `added #${context.nextId}: ${event.title}`],
            },
          };
        },

        // Guards: past the per-command step budget, or an id that is not in the
        // list. Returning `undefined` makes the transition illegal, so the
        // decide step is rejected (failure: 'rejected-by-guard') and retried —
        // and once the budget is spent only DONE and QUIT remain legal.
        TOGGLE_TODO: ({ context, event }) => {
          if (context.applied.length >= MAX_STEPS_PER_COMMAND) return undefined;
          const found = context.todos.find((todo) => todo.id === event.id);
          if (!found) return undefined;
          const todos = context.todos.map((todo) =>
            todo.id === event.id ? { ...todo, done: !todo.done } : todo,
          );
          return {
            target: "applying" as const,
            context: {
              todos,
              applied: [...context.applied, `TOGGLE_TODO ${JSON.stringify({ id: event.id })}`],
              log: [...context.log, `toggled #${event.id}`],
            },
          };
        },

        // Guard: only deletable if the id exists.
        DELETE_TODO: ({ context, event }) => {
          if (context.applied.length >= MAX_STEPS_PER_COMMAND) return undefined;
          const found = context.todos.find((todo) => todo.id === event.id);
          if (!found) return undefined;
          const todos = context.todos.filter((todo) => todo.id !== event.id);
          return {
            target: "applying" as const,
            context: {
              todos,
              applied: [...context.applied, `DELETE_TODO ${JSON.stringify({ id: event.id })}`],
              log: [...context.log, `deleted #${event.id}`],
            },
          };
        },

        // The explicit loop exit: the command is fully handled, so stop
        // deciding and settle idle for the next command.
        DONE: {
          target: "awaitingCommand",
          context: { pendingCommand: null, applied: [] },
        },

        QUIT: {
          target: "done",
        },
      },
    },

    // The loop's turnaround: applying an event lands here and immediately
    // re-enters `planning`, which starts the next decide step.
    applying: {
      always: { target: "planning" },
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

type TodoSnapshot = SnapshotFrom<typeof todoMachine>;

/** The label a host shows while the machine is idle in `awaitingCommand`. */
export function idlePrompt(snapshot: TodoSnapshot): string {
  return getInteraction(snapshot)?.label || "What would you like to do?";
}

/**
 * Run the machine to completion, resuming every idle settle with the next
 * command. Dual-mode: tests pass a scripted `decide` plus scripted commands
 * (so CI needs no API key); the direct run uses real models and stdin.
 */
export async function runTodoNlExample(options?: {
  input?: { todos?: Todo[] };
  executors?: AgentRequestExecutors;
  /** Scripted commands, consumed in order on each idle settle. */
  commands?: string[];
  onTransition?: (snapshot: TodoSnapshot) => void;
}) {
  const queued = [...(options?.commands ?? [])];

  const shared = {
    executors: options?.executors ?? createAiSdkExecutors({ models }),
    ...(options?.onTransition ? { onTransition: options.onTransition } : {}),
  };

  let result = await runAgent(todoMachine, {
    input: { todos: options?.input?.todos ?? [] },
    ...shared,
  });

  // Each command settles the run idle in `awaitingCommand`. Resume from
  // persisted snapshot from `result.persist()` with the COMMAND interaction.
  while (result.status === "idle") {
    const text = queued.shift() ?? (await promptLine(`${idlePrompt(result.snapshot)}\n> `));
    result = await runAgent(todoMachine, {
      snapshot: result.persist(),
      event: { type: "COMMAND", text },
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Todo NL did not complete: ${result.status}`);
  }
  return result.output;
}

export async function main() {
  const output = await runTodoNlExample({
    onTransition: (snapshot) => console.log("[state]", getStatePath(snapshot)),
  });

  console.log("\nFinal todo list:");
  console.log(renderTodoList(output.todos));
  console.log(`\n${output.log.length} action(s) taken.`);
}

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
