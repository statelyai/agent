import { AnyMachineSnapshot, AnyStateNode, EventObject } from 'xstate';
import zodToJsonSchema, {
  JsonSchema7ObjectType,
  JsonSchema7Type,
} from 'zod-to-json-schema';
import { ZodEventMapping } from './schemas';
import { z } from 'zod';
import { ObservedState } from './agent';

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

export type EventSchemas = {
  [key: string]: {
    description?: string;
    properties?: {
      [key: string]: JsonSchema7Type;
    };
  };
};

export type AgentPlan<TEvent extends EventObject> = {
  goal: string;
  state: ObservedState;
  steps: Array<{
    event: TEvent;
    nextState?: ObservedState;
  }>;
  nextEvent: TEvent | undefined;
};

export type PromptTemplate = (data: {
  goal: string;
  context: any;
  logic?: unknown;
  transitions?: TransitionData[];
}) => string;

export function createZodEventSchemas<T extends ZodEventMapping>(
  eventSchemas: T
): {
  [K in keyof T]: JsonSchema7ObjectType;
} {
  const resolvedeventSchemas = {};

  for (const [eventType, zodType] of Object.entries(eventSchemas)) {
    // @ts-ignore
    resolvedeventSchemas[eventType] = zodToJsonSchema(
      zodType.extend({
        type: z.literal(eventType),
      })
    );
  }

  return resolvedeventSchemas as any;
}

export interface TransitionData {
  eventType: string;
  description?: string;
  guard?: { type: string };
  target?: any;
}
