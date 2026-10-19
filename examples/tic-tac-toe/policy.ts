/**
 * The POLICY layer: player O's strategy as a JSON `AgentWorkflowConfig`.
 *
 * A policy takes the board features (features.ts) as input, keeps them at
 * `context.facts`, and ends in a final state whose output is ONE move,
 * `{ "type": "O.play", "cell": n }`. It makes no model calls: the
 * vocabulary has no actors, requests, named guards, or actions, so a policy
 * is a ladder of `choice` states over the features, and it evaluates
 * synchronously. That is what lets proof.ts run it inside `canReach`.
 *
 * Wrapped by `createPolicyDecide`, a policy is a `decide` executor the game's
 * boundary (play.ts) calls like any other decider.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { z } from "zod";
import { initialTransition, type AnyStateMachine } from "xstate";
import {
  setupAgent,
  type AgentDecisionExecutor,
  type AgentWorkflowConfig,
  type SchemaCompiler,
  type StandardSchemaV1,
} from "@statelyai/agent";
import { boardFeatures, FEATURE_NAMES, type Features } from "./features.js";
import type { Board } from "./game.js";

// ─── Schemas ───

// The Ajv-to-StandardSchema recipe from examples/json-agent.
const ajv = new Ajv({ strict: false });
export const ajvCompileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
  const validate = ajv.compile(jsonSchema);
  return {
    "~standard": {
      version: 1,
      vendor: "ajv",
      validate: (value: unknown) =>
        validate(value)
          ? { value }
          : {
              issues: (validate.errors ?? []).map((error) => ({
                message: `${name}${error.instancePath} ${error.message}`,
              })),
            },
      jsonSchema: { input: () => jsonSchema },
    },
  };
};

const cells = { type: "array", items: { type: "integer", minimum: 0, maximum: 8 } };

/** The policy's input: every feature, all required. */
const inputJsonSchema = {
  type: "object",
  properties: Object.fromEntries(
    FEATURE_NAMES.map((name) => [
      name,
      name === "board"
        ? { type: "array", items: { enum: ["X", "O", null] }, minItems: 9, maxItems: 9 }
        : cells,
    ]),
  ),
  required: [...FEATURE_NAMES],
};

/** One move: what every policy run outputs. */
export const moveSchema = z.object({
  type: z.literal("O.play"),
  cell: z.number().int().min(0).max(8),
});
export type Move = z.infer<typeof moveSchema>;

/**
 * The config a policy actually lowers to: the authored JSON plus the fixed
 * interface. `schemas` is always the vocabulary's; a policy authors `id`,
 * `description`, `context`, `initial`, and `states`.
 */
export function withPolicyInterface(config: AgentWorkflowConfig): AgentWorkflowConfig {
  return {
    ...config,
    schemas: {
      input: inputJsonSchema,
      context: {
        type: "object",
        properties: { facts: { type: "object" } },
        required: ["facts"],
      },
      output: {
        type: "object",
        properties: {
          type: { const: "O.play" },
          cell: { type: "integer", minimum: 0, maximum: 8 },
        },
        required: ["type", "cell"],
      },
    },
  };
}

/** Lowers a policy with the vocabulary's schemas. Throws like `fromConfig`. */
export function lowerPolicy(config: AgentWorkflowConfig): AnyStateMachine {
  return setupAgent.fromConfig(withPolicyInterface(config), { compileSchema: ajvCompileSchema })
    .machine;
}

/** Reads `policies/<name>.json`. */
export function loadPolicy(name: string): AgentWorkflowConfig {
  const path = fileURLToPath(new URL(`./policies/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as AgentWorkflowConfig;
}

// ─── Running a policy ───

/**
 * The policy's move on `board`, computed synchronously: the lowered machine's
 * initial macrostep runs the whole choice ladder (`initialTransition`, pure,
 * no actor), and its final output is the move. A policy that does not finish
 * in that macrostep, or outputs anything but a move, throws.
 */
export function policyMove(machine: AnyStateMachine, board: Board): Move {
  return moveFromFacts(machine, boardFeatures(board));
}

function moveFromFacts(machine: AnyStateMachine, facts: Features): Move {
  const [snapshot] = initialTransition(machine, facts);
  if (snapshot.status !== "done") {
    throw new Error(
      `policy '${machine.id}' did not finish synchronously (status '${snapshot.status}' in ${JSON.stringify(snapshot.value)})`,
    );
  }
  const move = moveSchema.safeParse(snapshot.output);
  if (!move.success) {
    throw new Error(
      `policy '${machine.id}' output is not a move: ${JSON.stringify(snapshot.output)}`,
    );
  }
  return move.data;
}

export type PolicyDecide = AgentDecisionExecutor & {
  machine: AnyStateMachine;
  config: AgentWorkflowConfig;
};

/** The board on a `decideNext` request: `request.input` is `{ value, context }`. */
export function boardOf(request: { input?: unknown }): Board {
  const context = (request.input as { context?: { board?: Board } } | undefined)?.context;
  if (!Array.isArray(context?.board)) throw new Error("decide request carries no board");
  return context.board;
}

/**
 * Lowers `config` once and returns a decision executor that runs it on the
 * request's board. The move must be one of the offered options; `decideNext`
 * retries anything else, and the policy is deterministic, so it fails the same
 * way every retry.
 */
export function createPolicyDecide(config: AgentWorkflowConfig): PolicyDecide {
  const machine = lowerPolicy(config);
  const decide: AgentDecisionExecutor = async (request) => ({
    event: policyMove(machine, boardOf(request)),
  });
  return Object.assign(decide, { machine, config });
}
