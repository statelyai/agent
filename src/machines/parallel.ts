import type { AnyStateMachine } from "xstate";
import { setupAgent } from "../setup-agent.js";
import {
  assertEntryNames,
  entryInput,
  entrySrc,
  jsonRecord,
  jsonString,
  machineActors,
  objectSchema,
  type PresetEntry,
} from "./internal.js";

/** Config for {@link createParallelMachine}. */
export interface CreateParallelMachineConfig {
  /** Default model ref for request branches. */
  model: string;
  /** The branches, run concurrently. Each is an inline request or a child machine. */
  branches: Record<string, PresetEntry>;
}

/** Context of a {@link createParallelMachine} machine. */
export type ParallelContext = {
  prompt: string;
  results: Record<string, unknown>;
};

const contextSchema = objectSchema<ParallelContext>({ prompt: jsonString, results: jsonRecord }, [
  "prompt",
  "results",
]);
const inputSchema = objectSchema<{ prompt: string }>({ prompt: jsonString }, ["prompt"]);
const outputSchema = objectSchema<{ results: Record<string, unknown> }>({ results: jsonRecord }, [
  "results",
]);

/**
 * Static fan-out: every branch runs concurrently as its own region of one
 * parallel state, and the run joins when all of them finish. Results are keyed
 * by branch name.
 *
 * Branch count is fixed at author time. For an N decided at run time (a planner
 * choosing subtopics), eject to `examples/fan-out`, which spawns branches
 * dynamically.
 *
 * States: `running` (one region per branch) → `done`.
 *
 * ```ts
 * const machine = createParallelMachine({
 *   model: "quick",
 *   branches: {
 *     security: { instructions: "Review for security issues." },
 *     performance: { instructions: "Review for performance issues." },
 *   },
 * });
 * ```
 */
export function createParallelMachine(config: CreateParallelMachineConfig): AnyStateMachine {
  const { model, branches } = config;
  const names = Object.keys(branches);
  assertEntryNames("branch", names, ["running", "done"]);

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    output: outputSchema,
    actors: machineActors(branches),
  });

  const regions: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(branches)) {
    regions[name] = {
      initial: "running",
      states: {
        running: {
          invoke: {
            id: name,
            src: entrySrc(name, entry),
            input: ({ context }: { context: ParallelContext }) =>
              entryInput(name, entry, model, context.prompt),
            onDone: ({ context, output }: { context: ParallelContext; output: unknown }) => ({
              target: "done",
              context: { results: { ...context.results, [name]: output } },
            }),
          },
        },
        done: { type: "final" },
      },
    };
  }

  const machineConfig = {
    id: "parallel",
    // Stamped by runAgent onto snapshots/logs instead of the structural hash;
    // bumped only on a topology change a snapshot could not resume into.
    version: "1",
    context: ({ input }: { input: { prompt: string } }) => ({
      prompt: input.prompt,
      results: {},
    }),
    initial: "running",
    states: {
      running: {
        type: "parallel",
        states: regions,
        onDone: { target: "done" },
      },
      done: {
        type: "final",
        output: ({ context }: { context: ParallelContext }) => ({ results: context.results }),
      },
    },
  } as unknown as Parameters<typeof agentSetup.createMachine>[0];

  const machine = agentSetup.createMachine(machineConfig);

  return machine as unknown as AnyStateMachine;
}
