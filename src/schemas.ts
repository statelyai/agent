import { SomeZodObject } from 'zod';
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
