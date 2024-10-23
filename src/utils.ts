import {
  ActorRefLike,
  AnyActorRef,
  AnyMachineSnapshot,
  AnyStateMachine,
  AnyStateNode,
} from 'xstate';
import hash from 'object-hash';
import { TransitionData } from './types';

export function getAllTransitions(state: AnyMachineSnapshot): TransitionData[] {
  const nodes = state._nodes;
  const transitions = (nodes as AnyStateNode[])
    .map((node) => [...(node as AnyStateNode).transitions.values()])
    .map((nodeTransitions) => {
      return nodeTransitions.map((nodeEventTransitions) => {
        return nodeEventTransitions.map((transition) => {
          return {
            ...transition,
            guard:
              typeof transition.guard === 'string'
                ? { type: transition.guard }
                : (transition.guard as any), // TODO: fix
          };
        });
      });
    })
    .flat(2);

  return transitions;
}

export function getAllMachineTransitions(
  stateNode: AnyStateNode
): TransitionData[] {
  const transitions: TransitionData[] = [...stateNode.transitions.values()]
    .map((nodeTransitions) => {
      return nodeTransitions.map((transition) => {
        return {
          ...transition,
          guard:
            typeof transition.guard === 'string'
              ? { type: transition.guard }
              : (transition.guard as any), // TODO: fix
        };
      });
    })
    .flat(2);

  for (const s of Object.values(stateNode.states)) {
    const stateTransitions = getAllMachineTransitions(s);
    transitions.push(...stateTransitions);
  }

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

const machineHashes: WeakMap<AnyStateMachine, string> = new WeakMap();
/**
 * Returns a string hash representing only the transitions in the state machine.
 */
export function getMachineHash(machine: AnyStateMachine): string {
  if (machineHashes.has(machine)) return machineHashes.get(machine)!;
  const transitions = getAllMachineTransitions(machine.root);
  const machineHash = hash(transitions);
  machineHashes.set(machine, machineHash);
  return machineHash;
}

export function isActorRef(
  actorRefLike: ActorRefLike
): actorRefLike is AnyActorRef {
  return (
    'src' in actorRefLike &&
    'system' in actorRefLike &&
    'sessionId' in actorRefLike
  );
}
