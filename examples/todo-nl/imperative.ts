/**
 * Todo NL — imperative A/B contrast (NO @statelyai/agent).
 *
 * This is the SAME natural-language todo manager as `index.ts`, rebuilt with
 * nothing but the raw `ai` package: one `generateObject` call per turn against
 * a zod discriminated union of actions, a hand-written multi-action `while`
 * loop, a manual `switch`, and manual validity checks. It exists purely to
 * compare against the machine version, which drives the same multi-action
 * command through a single `agent.plan` invoke.
 *
 * Read the two side by side. What the machine (`index.ts`) buys you that this
 * file has to do by hand — or can't do at all:
 *
 *   - Typed events: in the machine, `ADD_TODO`/`TOGGLE_TODO`/… are the event
 *     schema. Here the action union and the `switch` are two separate things
 *     that must be kept in sync manually; a missed case is a silent no-op.
 *   - The multi-action loop, for free: "add X and Y" needs two events. Here we
 *     hand-write the `while` loop below — call the model, apply, feed back
 *     what was applied, repeat until `nothing`, with a manual `maxSteps` cap.
 *     `index.ts` gets the identical behaviour from one `agent.plan` invoke: the
 *     built-in done move ends it, `maxSteps` caps it, and the applied trail is
 *     appended automatically.
 *   - Guard rejection + retry: the machine rejects a TOGGLE/DELETE on a
 *     nonexistent id (`rejected-by-guard`) and re-asks the model with that
 *     feedback, mid-plan. Here (see `applyAction`) a bad id is just *silently
 *     ignored* — the model never learns it was wrong, so it can't self-correct.
 *   - Resumable snapshot: the machine's state is a serializable XState
 *     snapshot you can persist and resume. Here the state is local `while`-loop
 *     variables that vanish when the function returns.
 *   - Testable without mocking your own loop: the machine is driven by
 *     injected `decide`/`userInput` executors (see index.test.ts). Here the
 *     loop, the model call, and the mutation are fused, so testing means
 *     mocking `generateObject` and re-implementing the loop's expectations.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/todo-nl/imperative.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

// The action union — the imperative analogue of the machine's event schemas.
// Nothing links it to the `switch` below except discipline.
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_todo"), title: z.string() }),
  z.object({ type: z.literal("toggle_todo"), id: z.number() }),
  z.object({ type: z.literal("delete_todo"), id: z.number() }),
  z.object({ type: z.literal("nothing"), reason: z.string() }),
  z.object({ type: z.literal("quit") }),
]);

type Action = z.infer<typeof actionSchema>;

const SYSTEM_PROMPT =
  "You manage a todo list by translating a user's natural-language command " +
  "into exactly one list operation action. Prefer the most direct mapping. " +
  "Only reference todo ids that appear in the current list. If the command " +
  "asks to quit/exit, choose quit. If the command maps to no (further) " +
  "action, choose nothing with a short reason.";

function renderTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "(the todo list is empty)";
  return todos.map((todo) => `  #${todo.id} [${todo.done ? "x" : " "}] ${todo.title}`).join("\n");
}

/** How to fetch the model's next action for a command. Injectable for tests. */
export type ChooseAction = (args: {
  todos: Todo[];
  command: string;
  applied: string[];
}) => Promise<Action>;

const defaultChooseAction: ChooseAction = async ({ todos, command, applied }) => {
  const { object } = await generateObject({
    model: openai("gpt-5.4-mini"),
    schema: actionSchema,
    system: SYSTEM_PROMPT,
    prompt: [
      "Current todo list:",
      renderTodoList(todos),
      "",
      `User command: ${command}`,
      applied.length === 0
        ? "Nothing has been applied for this command yet."
        : ["Already applied for this command:", ...applied.map((line) => `  - ${line}`)].join("\n"),
      "Choose the single next action for this command.",
    ].join("\n"),
  });
  return object;
};

export interface TodoAppState {
  todos: Todo[];
  nextId: number;
  log: string[];
}

/**
 * Apply one action, mutating `state`. Returns a human-readable summary, or
 * null when the action was a no-op. NOTE the silent-ignore branches: a
 * toggle/delete on a missing id just does nothing and the model is never told
 * — the exact failure the machine version turns into a typed retry.
 */
export function applyAction(state: TodoAppState, action: Action): string | null {
  switch (action.type) {
    case "add_todo": {
      const id = state.nextId++;
      state.todos.push({ id, title: action.title, done: false });
      state.log.push(`added #${id}: ${action.title}`);
      return `added "${action.title}" as #${id}`;
    }
    case "toggle_todo": {
      const target = state.todos.find((todo) => todo.id === action.id);
      if (!target) return null; // silently ignored — model gets no feedback
      target.done = !target.done;
      state.log.push(`toggled #${action.id}`);
      return `toggled #${action.id} to ${target.done ? "done" : "not done"}`;
    }
    case "delete_todo": {
      const index = state.todos.findIndex((todo) => todo.id === action.id);
      if (index === -1) return null; // silently ignored
      const [removed] = state.todos.splice(index, 1);
      state.log.push(`deleted #${action.id}`);
      return `deleted #${action.id} ("${removed!.title}")`;
    }
    case "nothing":
    case "quit":
      return null;
  }
}

/**
 * Interpret a single command, looping to drain multi-action commands
 * ("add X and Y") until the model returns `nothing`. Returns true to keep
 * running, false to quit.
 */
async function interpretCommand(
  state: TodoAppState,
  command: string,
  chooseAction: ChooseAction,
  maxSteps = 8,
): Promise<boolean> {
  const applied: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const action = await chooseAction({ todos: state.todos, command, applied });
    if (action.type === "quit") return false;
    if (action.type === "nothing") {
      if (applied.length === 0) state.log.push(`(no action: ${action.reason})`);
      return true;
    }
    const summary = applyAction(state, action);
    if (summary === null) {
      // Bad id (or other no-op): nothing to feed back, and looping again would
      // just repeat. Give up on this command. The machine's `agent.plan`
      // instead retries the same step with a 'rejected-by-guard' reason.
      return true;
    }
    applied.push(summary);
  }
  return true;
}

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
  const state: TodoAppState = { todos: [], nextId: 1, log: [] };
  let running = true;
  while (running) {
    const command = await promptCommand(
      [
        "Current todo list:",
        renderTodoList(state.todos),
        "What would you like to do? (or 'quit')",
      ].join("\n"),
    );
    running = await interpretCommand(state, command, defaultChooseAction);
  }

  console.log("\nFinal todo list:");
  console.log(renderTodoList(state.todos));
  console.log(`\n${state.log.length} action(s) taken.`);
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
