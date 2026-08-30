import { setupAgent } from "../setup-agent.js";
import type { AgentTools, StandardSchemaV1 } from "../types.js";
import {
  assertEntryNames,
  GENERATE_TEXT_SRC,
  jsonAny,
  jsonRecord,
  jsonString,
  objectSchema,
  requestInput,
  type PresetMachine,
} from "./internal.js";

/** Arguments a {@link SequentialStep}'s `prompt` receives. */
export interface SequentialPromptArgs {
  /** The machine's `input.prompt`. */
  prompt: string;
  /** Every completed step's output, keyed by step name. */
  results: Record<string, unknown>;
  /** The previous step's output (`null` for the first step). */
  previous: unknown;
}

/** One step of a {@link createSequentialMachine} chain. */
export interface SequentialStep {
  /** Step name. Becomes the state name and the `results` key. */
  name: string;
  /** System prompt for this step. */
  instructions?: string;
  /** Builds this step's prompt. Defaults to the previous step's output (the machine's `prompt` for the first step). */
  prompt?: (args: SequentialPromptArgs) => string;
  /** Structured output schema for this step. */
  outputSchema?: StandardSchemaV1;
  /** Model ref for this step. Falls back to the factory's `model`. */
  model?: string;
  /** Tools the host runs inside this step's request. */
  tools?: AgentTools;
  /** Bounds this step's host-side tool loop (the request's typed `maxSteps`). */
  maxSteps?: number;
}

/** Config for {@link createSequentialMachine}. */
export interface CreateSequentialMachineConfig {
  /** Default model ref for every step. */
  model: string;
  /** The chain, run in array order. */
  steps: readonly SequentialStep[];
}

/** Context of a {@link createSequentialMachine} machine. */
export type SequentialContext = {
  prompt: string;
  results: Record<string, unknown>;
  previous: unknown;
};

/** Machine input of a {@link createSequentialMachine} machine. */
export type SequentialInput = { prompt: string };
/** Machine output of a {@link createSequentialMachine} machine. */
export type SequentialOutput = { results: Record<string, unknown>; output: unknown };
/** The machine {@link createSequentialMachine} returns. */
export type SequentialMachine = PresetMachine<SequentialContext, SequentialInput, SequentialOutput>;

const contextSchema = objectSchema<SequentialContext>(
  { prompt: jsonString, results: jsonRecord, previous: jsonAny },
  ["prompt", "results"],
);
const inputSchema = objectSchema<{ prompt: string }>({ prompt: jsonString }, ["prompt"]);
const outputSchema = objectSchema<{ results: Record<string, unknown>; output: unknown }>(
  { results: jsonRecord, output: jsonAny },
  ["results"],
);

/**
 * A prompt chain: each step is one state, and each step's output feeds the
 * next. The default prompt for a step is the previous step's output, so a
 * chain needs no `prompt` functions at all.
 *
 * States: one per step, in order → `done`.
 *
 * ```ts
 * const machine = createSequentialMachine({
 *   model: "quick",
 *   steps: [
 *     { name: "outline", instructions: "Outline the post." },
 *     { name: "draft", instructions: "Write the post from the outline." },
 *     { name: "polish", instructions: "Tighten the prose." },
 *   ],
 * });
 * ```
 */
export function createSequentialMachine(config: CreateSequentialMachineConfig): SequentialMachine {
  const { model, steps } = config;
  assertEntryNames(
    "step",
    steps.map((step) => step.name),
    ["done"],
  );

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    output: outputSchema,
  });

  const states: Record<string, unknown> = {};
  steps.forEach((step, index) => {
    const next = steps[index + 1]?.name ?? "done";
    states[step.name] = {
      invoke: {
        id: step.name,
        src: GENERATE_TEXT_SRC,
        input: ({ context }: { context: SequentialContext }) =>
          requestInput(
            step.name,
            {
              instructions: step.instructions,
              model: step.model,
              outputSchema: step.outputSchema,
              tools: step.tools,
              maxSteps: step.maxSteps,
            },
            model,
            step.prompt
              ? step.prompt({
                  prompt: context.prompt,
                  results: context.results,
                  previous: context.previous,
                })
              : context.previous === null || context.previous === undefined
                ? context.prompt
                : String(context.previous),
          ),
        onDone: ({ context, output }: { context: SequentialContext; output: unknown }) => ({
          target: next,
          context: {
            results: { ...context.results, [step.name]: output },
            previous: output,
          },
        }),
      },
    };
  });

  states.done = {
    type: "final",
    output: ({ context }: { context: SequentialContext }) => ({
      results: context.results,
      output: context.previous,
    }),
  };

  const machineConfig = {
    id: "sequential",
    // Stamped by runAgent onto snapshots/logs instead of the structural hash;
    // bumped only on a topology change a snapshot could not resume into.
    version: "1",
    context: ({ input }: { input: { prompt: string } }) => ({
      prompt: input.prompt,
      results: {},
      previous: null,
    }),
    initial: steps[0]!.name,
    states,
  } as unknown as Parameters<typeof agentSetup.createMachine>[0];

  const machine = agentSetup.createMachine(machineConfig);

  return machine as unknown as SequentialMachine;
}
