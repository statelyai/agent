import { AnyMachineSnapshot, AnyStateNode } from 'xstate';
import zodToJsonSchema, { JsonSchema7ObjectType } from 'zod-to-json-schema';
import { ZodEventMapping } from './schemas';
import { z } from 'zod';
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
