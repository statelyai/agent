import { ActorOptions, AnyStateMachine, createActor } from 'xstate';

export function createAgent<T extends AnyStateMachine>(
  ...args: Parameters<typeof createActor<T>>
) {
  const [machine, options] = args;
  return createActor(machine, options);
}
