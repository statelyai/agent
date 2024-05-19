import { SomeZodObject } from 'zod';
import { JsonSchema7Type } from 'zod-to-json-schema';

export type ZodEventMapping = {
  // map event types to Zod types
  [eventType: string]: SomeZodObject;
};

export type EventSchemas<TEventType extends string> = {
  [K in TEventType]: JsonSchema7Type;
};
