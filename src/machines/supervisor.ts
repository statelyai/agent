import type { AnyStateMachine } from "xstate";
import { setupAgent } from "../setup-agent.js";
import {
  assertEntryNames,
  DECIDE_SRC,
  emptyPayload,
  entryInput,
  entrySrc,
  jsonNumber,
  jsonRecord,
  jsonString,
  machineActors,
  objectSchema,
  renderEntryList,
  type PresetEntry,
} from "./internal.js";

/** Config for {@link createSupervisorMachine}. */
export interface CreateSupervisorMachineConfig {
  /** Model ref for the supervising decision, and the default for request workers. */
  model: string;
  /** System prompt for the supervising decision. */
  instructions?: string;
  /** The workers the supervisor may delegate to, keyed by name. */
  workers: Record<string, PresetEntry>;
  /** Hard upper bound on delegations, enforced by a guard. Default 6. */
  maxTurns?: number;
}

/** Context of a {@link createSupervisorMachine} machine. */
export type SupervisorContext = {
  task: string;
  results: Record<string, unknown>;
  turns: number;
  worker: string | null;
};

const contextSchema = objectSchema<SupervisorContext>(
  {
    task: jsonString,
    results: jsonRecord,
    turns: jsonNumber,
    worker: { type: ["string", "null"] },
  },
  ["task", "results", "turns"],
);
const inputSchema = objectSchema<{ task: string }>({ task: jsonString }, ["task"]);
const outputSchema = objectSchema<{ results: Record<string, unknown>; turns: number }>(
  { results: jsonRecord, turns: jsonNumber },
  ["results", "turns"],
);

/** The event a supervising decision chooses to delegate to a worker: `DELEGATE_<name>`. */
export function delegateEventType(worker: string): string {
  return `DELEGATE_${worker}`;
}

/** The event a supervising decision chooses to stop. */
export const FINISH_EVENT_TYPE = "FINISH";

/**
 * A supervisor delegating to typed workers: each turn, one `agent.decide`
 * picks a worker or `FINISH`. Worker results accumulate in context and are fed
 * back into the next decision.
 *
 * Control always returns to the supervisor after a worker finishes — that is
 * what separates this from {@link createHandoffMachine}, where control
 * transfers and does not come back.
 *
 * `maxTurns` bounds the delegations twice over: a spent budget removes every
 * `DELEGATE_*` from the decision's candidate events, and a guard on each
 * delegate transition rejects one anyway. `FINISH` is all that is left.
 *
 * States: `supervising` → one state per worker → `supervising` → … → `done`.
 *
 * ```ts
 * const machine = createSupervisorMachine({
 *   model: "quick",
 *   workers: {
 *     researcher: { description: "Facts and background", instructions: "Research it." },
 *     writer: { description: "Prose and summaries", instructions: "Write it up." },
 *   },
 *   maxTurns: 4,
 * });
 * ```
 */
export function createSupervisorMachine(config: CreateSupervisorMachineConfig): AnyStateMachine {
  const { model, instructions, workers, maxTurns = 6 } = config;
  const names = Object.keys(workers);
  assertEntryNames("worker", names, ["supervising", "done"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("createSupervisorMachine: maxTurns must be an integer >= 1.");
  }

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    output: outputSchema,
    events: {
      ...Object.fromEntries(names.map((name) => [delegateEventType(name), emptyPayload])),
      [FINISH_EVENT_TYPE]: emptyPayload,
    },
    actors: machineActors(workers),
  });

  const workerList = renderEntryList(workers);

  const states: Record<string, unknown> = {
    supervising: {
      invoke: {
        id: "supervise",
        src: DECIDE_SRC,
        input: ({ context }: { context: SupervisorContext }) => ({
          model,
          system:
            instructions ??
            "You are a supervisor. Delegate the task to one worker at a time, " +
              "then finish once the accumulated results answer it.",
          prompt:
            `Task:\n${context.task}\n\nWorkers:\n${workerList}\n\n` +
            `Results so far:\n${renderResults(context.results)}\n\n` +
            `Turns used: ${context.turns} of ${maxTurns}.`,
          // The turn budget narrows the candidate set itself: once it is
          // spent, FINISH is the only event the model may choose (the guard
          // below still rejects a delegate, but the model never sees one).
          allowedEvents:
            context.turns < maxTurns
              ? [...names.map(delegateEventType), FINISH_EVENT_TYPE]
              : [FINISH_EVENT_TYPE],
        }),
      },
      on: {
        ...Object.fromEntries(
          names.map((name) => [
            delegateEventType(name),
            // The turn budget, as a guard: an exhausted budget makes every
            // delegate illegal, leaving FINISH as the only legal choice.
            ({ context }: { context: SupervisorContext }) =>
              context.turns < maxTurns ? { target: name, context: { worker: name } } : undefined,
          ]),
        ),
        [FINISH_EVENT_TYPE]: { target: "done" },
      },
    },
    done: {
      type: "final",
      output: ({ context }: { context: SupervisorContext }) => ({
        results: context.results,
        turns: context.turns,
      }),
    },
  };

  for (const [name, entry] of Object.entries(workers)) {
    states[name] = {
      invoke: {
        id: name,
        src: entrySrc(name, entry),
        input: ({ context }: { context: SupervisorContext }) =>
          entryInput(name, entry, model, context.task),
        onDone: ({ context, output }: { context: SupervisorContext; output: unknown }) => ({
          target: "supervising",
          context: {
            results: { ...context.results, [name]: output },
            turns: context.turns + 1,
          },
        }),
      },
    };
  }

  const machineConfig = {
    id: "supervisor",
    // Stamped by runAgent onto snapshots/logs instead of the structural hash;
    // bumped only on a topology change a snapshot could not resume into.
    version: "1",
    context: ({ input }: { input: { task: string } }) => ({
      task: input.task,
      results: {},
      turns: 0,
      worker: null,
    }),
    initial: "supervising",
    states,
  } as unknown as Parameters<typeof agentSetup.createMachine>[0];

  const machine = agentSetup.createMachine(machineConfig);

  return machine as unknown as AnyStateMachine;
}

// Renders the accumulated worker results for the next supervising decision.
function renderResults(results: Record<string, unknown>): string {
  const entries = Object.entries(results);
  if (entries.length === 0) {
    return "(none yet)";
  }
  return entries
    .map(
      ([name, value]) => `- ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join("\n");
}
