import type { AnyStateMachine } from "xstate";
import { setupAgent } from "../setup-agent.js";
import {
  entryInput,
  entrySrc,
  isMachineEntry,
  jsonAny,
  jsonArray,
  jsonNumber,
  jsonString,
  objectSchema,
  type PresetEntry,
  type PresetMachineEntry,
} from "./internal.js";

/** The accumulated state a {@link CreateLoopMachineConfig.until} predicate reads. */
export interface LoopState {
  /** The machine's `input.prompt`. */
  prompt: string;
  /** Completed iterations. */
  iterations: number;
  /** Every iteration's output, in order. */
  results: unknown[];
  /** The latest iteration's output. */
  last: unknown;
}

/** Config for {@link createLoopMachine}. */
export interface CreateLoopMachineConfig {
  /** Default model ref for a request body. */
  model: string;
  /** The repeated unit of work: an inline request or a child machine. */
  body: PresetEntry & {
    /** Builds each iteration's prompt. Defaults to the machine's `prompt`. */
    prompt?: (state: LoopState) => string;
  };
  /** Stop condition, checked after each iteration. */
  until: (state: LoopState) => boolean;
  /** Hard upper bound on iterations, enforced by a guard. */
  maxIterations: number;
}

/** Context of a {@link createLoopMachine} machine. */
export type LoopContext = {
  prompt: string;
  iterations: number;
  results: unknown[];
  last: unknown;
};

const contextSchema = objectSchema<LoopContext>(
  { prompt: jsonString, iterations: jsonNumber, results: jsonArray, last: jsonAny },
  ["prompt", "iterations", "results"],
);
const inputSchema = objectSchema<{ prompt: string }>({ prompt: jsonString }, ["prompt"]);
const outputSchema = objectSchema<{ iterations: number; results: unknown[]; last: unknown }>(
  { iterations: jsonNumber, results: jsonArray, last: jsonAny },
  ["iterations", "results"],
);

/**
 * A bounded repeat: run the body, check `until` over the accumulated state,
 * and either stop or go again. `maxIterations` is a guard, so the loop cannot
 * run away even if `until` never returns `true`.
 *
 * States: `running` → `checking` → (`running` | `done`).
 *
 * ```ts
 * const machine = createLoopMachine({
 *   model: "quick",
 *   body: { instructions: "Improve the draft. Return only the draft." },
 *   until: ({ last }) => String(last).length > 500,
 *   maxIterations: 4,
 * });
 * ```
 */
export function createLoopMachine(config: CreateLoopMachineConfig): AnyStateMachine {
  const { model, body, until, maxIterations } = config;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("createLoopMachine: maxIterations must be an integer >= 1.");
  }

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    output: outputSchema,
    actors: isMachineEntry(body) ? { body: (body as PresetMachineEntry).machine } : {},
  });

  const loopState = (context: LoopContext): LoopState => ({
    prompt: context.prompt,
    iterations: context.iterations,
    results: context.results,
    last: context.last,
  });

  const machineConfig = {
    id: "loop",
    // Stamped by runAgent onto snapshots/logs instead of the structural hash;
    // bumped only on a topology change a snapshot could not resume into.
    version: "1",
    context: ({ input }: { input: { prompt: string } }) => ({
      prompt: input.prompt,
      iterations: 0,
      results: [],
      last: null,
    }),
    initial: "running",
    states: {
      running: {
        invoke: {
          id: "body",
          src: entrySrc("body", body),
          input: ({ context }: { context: LoopContext }) =>
            entryInput(
              "body",
              body,
              model,
              body.prompt ? body.prompt(loopState(context)) : context.prompt,
            ),
          onDone: ({ context, output }: { context: LoopContext; output: unknown }) => ({
            target: "checking",
            context: {
              iterations: context.iterations + 1,
              results: [...context.results, output],
              last: output,
            },
          }),
        },
      },
      // The bound, as a visible guard: stop on `until`, or when the iteration
      // budget is spent.
      checking: {
        type: "choice",
        choice: ({ context }: { context: LoopContext }) =>
          context.iterations >= maxIterations || until(loopState(context))
            ? { target: "done" }
            : { target: "running" },
      },
      done: {
        type: "final",
        output: ({ context }: { context: LoopContext }) => ({
          iterations: context.iterations,
          results: context.results,
          last: context.last,
        }),
      },
    },
  } as unknown as Parameters<typeof agentSetup.createMachine>[0];

  const machine = agentSetup.createMachine(machineConfig);

  return machine as unknown as AnyStateMachine;
}
