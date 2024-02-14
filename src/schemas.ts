import { Values } from 'xstate';
import {
  ContextSchema,
  EventSchemas,
  ConvertContextToJSONSchema,
  ConvertToJSONSchemas,
  createEventSchemas,
} from './utils';
import { FromSchema } from 'json-schema-to-ts';

export function createSchemas<
  TContextSchema extends ContextSchema,
  TEventSchemas extends EventSchemas
>({
  context,
  events,
}: {
  /**
   * An object mapping context properties to their JSON Schema.
   */
  context: TContextSchema;
  /**
   * An object mapping event types to each event object's JSON Schema.
   */
  events: TEventSchemas;
}): {
  context: ConvertContextToJSONSchema<TContextSchema>;
  events: ConvertToJSONSchemas<TEventSchemas>;
  types: {
    context: FromSchema<ConvertContextToJSONSchema<TContextSchema>>;
    events: FromSchema<Values<ConvertToJSONSchemas<TEventSchemas>>>;
  };
} {
  return {
    context: {
      type: 'object',
      properties: context,
      additionalProperties: false,
      required: Object.keys(context),
    },
    events: createEventSchemas(events),
    types: {} as any,
  };
}
