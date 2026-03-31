import type { AnyMachineSnapshot, AnyStateNode } from 'xstate';

export interface TransitionData {
  eventType: string;
  description?: string;
}

export function getAllTransitions(state: AnyMachineSnapshot): TransitionData[] {
  const nodes = state._nodes;
  const transitions = (nodes as AnyStateNode[])
    .map((node) => [...(node as AnyStateNode).transitions.values()])
    .map((nodeTransitions) => {
      return nodeTransitions.map((nodeEventTransitions) => {
        return nodeEventTransitions.map((transition) => ({
          eventType: transition.eventType,
          description: transition.description,
        }));
      });
    })
    .flat(2);

  return transitions;
}

export function randomId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return timestamp + random;
}
