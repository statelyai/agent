import type {
  AgentMachine,
  AgentSnapshot,
  AgentState,
  ExecuteResult,
} from '../types.js';

type LocalMachine = AgentMachine<any, any, any, any, any, any> & {
  invoke(state: AgentState): Promise<AgentState>;
  execute(state: AgentState): Promise<ExecuteResult>;
  stream(state: AgentState): AsyncGenerator<AgentSnapshot>;
};

function asLocalMachine(machine: AgentMachine): LocalMachine {
  const localMachine = machine as LocalMachine;
  if (
    typeof localMachine.invoke !== 'function'
    || typeof localMachine.execute !== 'function'
    || typeof localMachine.stream !== 'function'
  ) {
    throw new Error('Machine local interpreter internals are unavailable');
  }

  return localMachine;
}

export function invoke<
  TContext extends Record<string, unknown>,
  TValue extends string,
  TOutput,
>(
  machine: AgentMachine<any, TContext, any, any, TOutput, any>,
  state: AgentState<TContext, TValue, TOutput>
): Promise<AgentState<TContext, TValue, TOutput>> {
  return asLocalMachine(machine).invoke(state) as Promise<
    AgentState<TContext, TValue, TOutput>
  >;
}

export function execute<
  TContext extends Record<string, unknown>,
  TValue extends string,
  TEvents extends Record<string, import('../types.js').StandardSchemaV1>,
  TOutput,
>(
  machine: AgentMachine<any, TContext, TEvents, any, TOutput, any>,
  state: AgentState<TContext, TValue, TOutput>
): Promise<ExecuteResult<TContext, TValue, TEvents, TOutput>> {
  return asLocalMachine(machine).execute(state) as Promise<
    ExecuteResult<TContext, TValue, TEvents, TOutput>
  >;
}

export function stream<
  TContext extends Record<string, unknown>,
  TValue extends string,
  TOutput,
>(
  machine: AgentMachine<any, TContext, any, any, TOutput, any>,
  state: AgentState<TContext, TValue, TOutput>
): AsyncGenerator<AgentSnapshot<TContext, TValue, TOutput>> {
  return asLocalMachine(machine).stream(state) as AsyncGenerator<
    AgentSnapshot<TContext, TValue, TOutput>
  >;
}
