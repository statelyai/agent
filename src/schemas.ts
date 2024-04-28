import { Values } from 'xstate';
import { createZodEventSchemas } from './utils';
import { SomeZodObject, TypeOf } from 'zod';
import { JsonSchema7Type } from 'zod-to-json-schema';

export type ZodEventTypes = {
  // map event types to Zod types
  [eventType: string]: SomeZodObject;
};

export type EventSchemas<TEventType extends string> = {
  [K in TEventType]: JsonSchema7Type;
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
