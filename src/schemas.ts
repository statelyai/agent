import { ZodType, type SomeZodObject } from 'zod';

export type ZodEventMapping = {
  // map event types to Zod types
  [eventType: string]: SomeZodObject;
};

export type ZodContextMapping = {
  // map context keys to Zod types
  [contextKey: string]: ZodType;
};
