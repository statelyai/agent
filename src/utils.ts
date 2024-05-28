import { AnyMachineSnapshot, AnyStateNode } from 'xstate';
import { TransitionData } from './types';

export function getAllTransitions(state: AnyMachineSnapshot): TransitionData[] {
  const nodes = state._nodes;
  const transitions = (nodes as AnyStateNode[])
    .map((node) => [...(node as AnyStateNode).transitions.values()])
    .flat(2)
    .map((transition) => ({
      ...transition,
      guard:
        typeof transition.guard === 'string'
          ? { type: transition.guard }
          : (transition.guard as any), // TODO: fix
    }));

  return transitions;
}
