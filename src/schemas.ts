import { Values } from 'xstate';
import { createZodEventSchemas } from './utils';
import { SomeZodObject, TypeOf } from 'zod';

export type ZodEventTypes = {
  // map event types to Zod types
  [eventType: string]: SomeZodObject;
};

export function defineEvents<const TEventSchemas extends ZodEventTypes>(
  events: TEventSchemas
): {
  type: Values<{
    [K in keyof TEventSchemas]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;
  schemas: {
    [K in keyof TEventSchemas]: unknown;
  };
} {
  return {
    type: {} as any,
    schemas: createZodEventSchemas(events),
  };
}
