import { Values } from 'xstate';
import {
  EventSchemas,
  ConvertToJSONSchemas,
  createEventSchemas,
} from './utils';
import { FromSchema } from 'json-schema-to-ts';

export function defineEventSchemas<const TEventSchemas extends EventSchemas>(
  events: TEventSchemas
): {
  events: ConvertToJSONSchemas<TEventSchemas>;
  types: FromSchema<Values<ConvertToJSONSchemas<TEventSchemas>>>;
} {
  return {
    events: createEventSchemas(events),
    types: {} as any,
  };
}
