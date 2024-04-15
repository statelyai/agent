import { Values } from 'xstate';
import { createZodEventSchemas } from './utils';
import { SomeZodObject, TypeOf } from 'zod';

export type ZodEventTypes = {
  // map event types to Zod types
  [eventType: string]: SomeZodObject;
};

export type EventSchemas<TEventType extends string> = {
  [K in TEventType]: unknown;
};

export function defineEvents<const TEventSchemas extends ZodEventTypes>(
  events: TEventSchemas
): {
  types: Values<{
    [K in keyof TEventSchemas]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;
  schemas: EventSchemas<keyof TEventSchemas & string>;
} {
  return {
    types: {} as any,
    schemas: createZodEventSchemas(events),
  };
}
