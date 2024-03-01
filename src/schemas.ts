import { Values } from 'xstate';
import {
  ContextSchema,
  EventSchemas,
  ConvertToJSONSchemas,
  createEventSchemas,
} from './utils';
import { FromSchema } from 'json-schema-to-ts';

export function createSchemas<
  const TContextSchema extends ContextSchema,
  const TEventSchemas extends EventSchemas
>({
  context,
  events,
}: {
  /**
   * The JSON schema for the context object.
   *
   * Must be of `{ type: 'object' }`.
   */
  context?: TContextSchema;
  /**
   * An object mapping event types to each event object's JSON Schema.
   */
  events: TEventSchemas;
}): {
  context: TContextSchema | undefined;
  events: ConvertToJSONSchemas<TEventSchemas>;
  types: {
    context: FromSchema<TContextSchema>;
    events: FromSchema<Values<ConvertToJSONSchemas<TEventSchemas>>>;
  };
} {
  return {
    context,
    events: createEventSchemas(events),
    types: {} as any,
  };
}
