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

export function wrapInXml(tagName: string, content: string): string {
  return `<${tagName}>${content}</${tagName}>`;
}

export function randomId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return timestamp + random;
}
