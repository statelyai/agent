import {
  createAsyncLogic,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type AsyncActorLogic,
} from "xstate";
import type { AgentRequestOptions } from "../events.js";

export type AgentExecutionOptions = Pick<AgentRequestOptions, "schemas" | "actors"> & {
  models?: object;
};
export const agentExecutionOptions = new WeakMap<object, AgentExecutionOptions>();

/**
 * Machine-carried wait-state predicates, keyed on the machine's root `config`
 * object. `config` is shared by reference across `machine.provide(...)` (unlike
 * the machine object itself), so a predicate registered here travels with the
 * machine through `.provide` — which is why it is keyed on `config`, not the
 * machine. Set by `setupAgent({ isSuspended })` in `createMachine`, read by
 * `runAgent` (below the host `options.isSuspended` override, above the timing
 * heuristic).
 */
export const machineSuspensionPredicates = new WeakMap<
  object,
  (snapshot: AnyMachineSnapshot) => boolean
>();

/** Reads the {@link machineSuspensionPredicates} predicate carried by `machine` (via its root `config`), if any. */
export function getMachineSuspensionPredicate(
  machine: AnyStateMachine,
): ((snapshot: AnyMachineSnapshot) => boolean) | undefined {
  const config = (machine as { config?: object }).config;
  return config ? machineSuspensionPredicates.get(config) : undefined;
}

// Actor logic objects that are unbound placeholders (no host execution) and
// carry no `kind` marker of their own — `agent.userInput` and workflow-config
// actor stubs. runAgent's bind-time walk (§3.2) checks membership here to
// fail fast on invokes that reach one of these unimplemented.
export const unboundPlaceholderLogics = new WeakSet<object>();
/** Text/decision logics created WITH their own executor (withExecutor or the
 * factory's second arg) — these are runnable as-is, so runAgent's bind check
 * must not reject them as direct-object invoke srcs. */
export const executorBoundLogics = new WeakSet<object>();

export function missingActor(src: string): AsyncActorLogic<unknown, unknown> {
  const logic = createAsyncLogic<unknown, unknown>({
    run: async () => {
      throw new Error(
        `'${src}' has no host execution. Provide an implementation with ` +
          `machine.provide({ actors: { '${src}': ... } }).`,
      );
    },
  });
  unboundPlaceholderLogics.add(logic);
  return logic;
}

export function isUnboundPlaceholder(logic: unknown): boolean {
  return !!logic && typeof logic === "object" && unboundPlaceholderLogics.has(logic as object);
}

export function getRegisteredAgentExecutionOptions(
  machine: AnyActorLogic,
  options?: Partial<AgentExecutionOptions>,
): AgentExecutionOptions {
  return {
    ...agentExecutionOptions.get(machine as object),
    ...options,
  };
}
