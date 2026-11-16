import type { AnyStateMachine } from "xstate";
import { AgentError } from "../errors.js";
import { isStandardSchema, validateSchemaSync } from "../utils.js";
import { getRegisteredAgentExecutionOptions } from "./registry.js";

/**
 * Validates `input` against the machine's registered input schema, returning
 * the schema's output, so defaults are filled and transforms applied before
 * the value reaches `createActor`, the replayable event log, or a search.
 *
 * Standard Schema only (no validation library is referenced), so this works for
 * whatever the machine was declared with. Omitted input stays omitted rather
 * than being validated as `{}`: "started with no input" keeps meaning what it
 * has always meant, instead of newly failing schemas with required fields.
 * `caller` names the public function in the error message.
 *
 * @internal
 */
export function resolveMachineInput(
  machine: AnyStateMachine,
  input: unknown,
  caller: string,
): unknown {
  if (input === undefined) return input;
  const schema = getRegisteredAgentExecutionOptions(machine).schemas?.input;
  if (!isStandardSchema(schema)) return input;
  try {
    return validateSchemaSync(schema, input);
  } catch (error) {
    throw new AgentError(
      "invalid-machine-input",
      `${caller}: machine input failed validation against the declared input ` +
        `schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
