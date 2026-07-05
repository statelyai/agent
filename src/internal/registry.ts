import { createAsyncLogic, type AnyActorLogic, type AsyncActorLogic } from 'xstate';
import type { AgentRequestOptions } from '../events.js';

export type AgentExecutionOptions = Pick<AgentRequestOptions, 'schemas' | 'actorSources'>;
export const agentExecutionOptions = new WeakMap<object, AgentExecutionOptions>();

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
          `machine.provide({ actorSources: { '${src}': ... } }).`
      );
    },
  });
  unboundPlaceholderLogics.add(logic);
  return logic;
}

export function isUnboundPlaceholder(logic: unknown): boolean {
  return !!logic && typeof logic === 'object' && unboundPlaceholderLogics.has(logic as object);
}

export function getRegisteredAgentExecutionOptions(
  machine: AnyActorLogic,
  options?: Partial<AgentExecutionOptions>
): AgentExecutionOptions {
  return {
    ...(agentExecutionOptions.get(machine as object) ?? {}),
    ...options,
  };
}
