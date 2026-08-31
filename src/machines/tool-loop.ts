import { setupAgent } from "../setup-agent.js";
import type { AgentTools, StandardSchemaV1 } from "../types.js";
import {
  GENERATE_TEXT_SRC,
  jsonAny,
  jsonString,
  objectSchema,
  type PresetMachine,
} from "./internal.js";

/** Config for {@link createToolLoopMachine}. */
export interface CreateToolLoopMachineConfig {
  /** Model ref, or an alias from the host's `models` registry. */
  model: string;
  /** System prompt. */
  instructions?: string;
  /** Tools the host runs inside the one request. */
  tools?: AgentTools;
  /** Structured output schema. Omitted means the output is plain text. */
  outputSchema?: StandardSchemaV1;
  /**
   * Bounds the host-side tool loop — lowered to the request's typed
   * {@link AgentTextRequest.maxSteps}. It bounds MODEL STEPS inside one
   * request, not machine turns, hence the name.
   */
  maxSteps?: number;
}

/** Context of a {@link createToolLoopMachine} machine. */
export type ToolLoopContext = {
  prompt: string;
  result: unknown;
};

/** Machine input of a {@link createToolLoopMachine} machine. */
export type ToolLoopInput = { prompt: string };
/** Machine output of a {@link createToolLoopMachine} machine. */
export type ToolLoopOutput = { result: unknown };
/** The machine {@link createToolLoopMachine} returns. */
export type ToolLoopMachine = PresetMachine<ToolLoopContext, ToolLoopInput, ToolLoopOutput>;

const contextSchema = objectSchema<ToolLoopContext>({ prompt: jsonString, result: jsonAny }, [
  "prompt",
]);
const inputSchema = objectSchema<{ prompt: string }>({ prompt: jsonString }, ["prompt"]);
const outputSchema = objectSchema<{ result: unknown }>({ result: jsonAny }, ["result"]);

/**
 * The single-state tool loop: one text request carries the `tools`, and the
 * host runs the tool loop inside it (`maxSteps` bounds it). Selecting and
 * executing tools is the model + host's business, not machine states.
 *
 * States: `answering` → `done`.
 *
 * ```ts
 * const machine = createToolLoopMachine({
 *   model: "quick",
 *   instructions: "Answer using the tools.",
 *   tools: { calculate },
 *   maxSteps: 5,
 * });
 *
 * const result = await runAgent(machine, {
 *   input: { prompt: "What is 42 * 17?" },
 *   executors,
 * });
 * // Snapshots and log entries carry machine.version ("1") automatically.
 * ```
 */
export function createToolLoopMachine(config: CreateToolLoopMachineConfig): ToolLoopMachine {
  const { model, instructions, tools, outputSchema: resultSchema, maxSteps } = config;

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    output: outputSchema,
  });

  const machine = agentSetup.createMachine({
    id: "tool-loop",
    // The machine's own version (XState `createMachine({ version })`), stamped
    // by runAgent onto snapshots/logs instead of the structural hash. Bumped
    // only on a topology change a persisted snapshot could not resume into.
    version: "1",
    context: ({ input }) => ({ prompt: input.prompt, result: null }),
    initial: "answering",
    states: {
      answering: {
        invoke: {
          id: "answer",
          src: GENERATE_TEXT_SRC,
          input: ({ context }) => ({
            name: "answer",
            model,
            ...(instructions ? { system: instructions } : {}),
            prompt: context.prompt,
            ...(tools ? { tools } : {}),
            ...(resultSchema ? { outputSchema: resultSchema } : {}),
            ...(maxSteps !== undefined ? { maxSteps } : {}),
          }),
          onDone: ({ output }) => ({ target: "done", context: { result: output } }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({ result: context.result }),
      },
    },
  });

  return machine as unknown as ToolLoopMachine;
}
