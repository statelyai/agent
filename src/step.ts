import type { AgentMachine, AgentState } from './types.js';
import {
  applyTransition,
  getParentConfig,
  getParentParams,
  resolveStateConfig,
} from './utils.js';

/**
 * Execute one state transition.
 *
 * - Final state → status 'done' (or bubble to parent onDone)
 * - Decide/classify → call adapter, apply onDone
 * - Run state → execute run, apply onDone
 * - Waiting state (on, no run) → status 'waiting'
 */
export async function step(
  machine: AgentMachine,
  state: AgentState
): Promise<AgentState> {
  if (state.status === 'done' || state.status === 'error') {
    return state;
  }

  const config = resolveStateConfig(machine, state.value);

  // ─── Final state ───
  if (config.type === 'final') {
    return handleFinalState(machine, state);
  }

  // ─── Decide / Classify state ───
  if (config.__decideConfig) {
    return handleDecideState(machine, state);
  }

  // ─── Run state ───
  if (config.run) {
    return handleRunState(machine, state);
  }

  // ─── Waiting state ───
  if (config.on) {
    return { ...state, status: 'waiting' };
  }

  // ─── Compound state with no run (just initial + children) ───
  // This shouldn't normally happen since enterCompoundStates resolves on entry.
  // But handle defensively.
  if (config.states && config.initial) {
    return { ...state, status: 'running' };
  }

  return {
    ...state,
    status: 'error',
    error: `State '${state.value}' has no run, events, or children`,
  };
}

async function handleFinalState(
  machine: AgentMachine,
  state: AgentState
): Promise<AgentState> {
  const config = resolveStateConfig(machine, state.value);

  // Compute output
  const output = config.output
    ? config.output({ context: state.context })
    : undefined;

  const parts = state.value.split('.');

  // Root-level final state → done
  if (parts.length <= 1) {
    return { ...state, status: 'done', output };
  }

  // Nested final state — check parent for onDone
  const parentConfig = getParentConfig(machine, state.value);
  if (parentConfig?.onDone) {
    const parentPath = parts.slice(0, -1).join('.');
    const transition = parentConfig.onDone({
      result: output,
      context: state.context,
    });
    return applyTransition(machine, state, transition, parentPath);
  }

  // Parent has no onDone — match xstate semantics: compound state is "done"
  // but no transition fires. Machine halts here; ancestor on handlers can
  // still match events via sendEvent.
  return { ...state, status: 'waiting' };
}

async function handleDecideState(
  machine: AgentMachine,
  state: AgentState
): Promise<AgentState> {
  const config = resolveStateConfig(machine, state.value);
  const decideConfig = config.__decideConfig!;

  // Get adapter
  const adapter = decideConfig.adapter ?? machine.adapter;
  if (!adapter) {
    return {
      ...state,
      status: 'error',
      error: `No adapter configured for decide state '${state.value}'`,
    };
  }

  // Resolve prompt
  const parentParams = getParentParams(state);
  const prompt =
    typeof decideConfig.prompt === 'function'
      ? decideConfig.prompt({ context: state.context, parentParams })
      : decideConfig.prompt;

  try {
    const result = await adapter.decide({
      model: decideConfig.model,
      prompt,
      options: decideConfig.options,
      reasoning: decideConfig.reasoning,
    });

    // Apply onDone
    const transition = decideConfig.onDone({
      result,
      context: state.context,
    });
    return applyTransition(machine, state, transition, state.value);
  } catch (error) {
    return { ...state, status: 'error', error };
  }
}

async function handleRunState(
  machine: AgentMachine,
  state: AgentState
): Promise<AgentState> {
  const config = resolveStateConfig(machine, state.value);

  try {
    const result = await config.run!({
      context: state.context,
      parentParams: getParentParams(state),
    });

    if (config.onDone) {
      const transition = config.onDone({
        result,
        context: state.context,
      });
      return applyTransition(machine, state, transition, state.value);
    }

    // run with no onDone — stay in state, mark waiting if has events
    if (config.on) {
      return { ...state, status: 'waiting' };
    }
    return state;
  } catch (error) {
    return { ...state, status: 'error', error };
  }
}
