import { SomeZodObject } from 'zod';
import { JsonSchema7Type } from 'zod-to-json-schema';
import { AnyEventObject } from 'xstate';
import { ObservedState } from './types';

export type ZodEventMapping = {
  // map event types to Zod types
  [eventType: string]: SomeZodObject;
};

export type ZodActionMapping = {
  [eventType: string]: {
    schema: SomeZodObject;
    action: (state: ObservedState, event: AnyEventObject) => Promise<void>;
  };
};

export type EventSchemas<TEventType extends string> = {
  [K in TEventType]: JsonSchema7Type;
};
