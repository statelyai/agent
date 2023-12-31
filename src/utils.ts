import { AnyMachineSnapshot, AnyStateNode } from 'xstate';

export function getAllTransitions(state: AnyMachineSnapshot) {
  const nodes = state._nodes;
  const transitions = (nodes as AnyStateNode[])
    .map((node) => [...(node as AnyStateNode).transitions.values()])
    .flat(2);

  return transitions;
}
