import { AnyMachineSnapshot, AnyStateNode, Prop, Values } from 'xstate';
import { FromSchema } from 'json-schema-to-ts';
import { JSONSchema7 } from 'json-schema-to-ts/lib/types/definitions';

export function getAllTransitions(state: AnyMachineSnapshot) {
  const nodes = state._nodes;
  const transitions = (nodes as AnyStateNode[])
    .map((node) => [...(node as AnyStateNode).transitions.values()])
    .flat(2);

  return transitions;
}

export type EventSchemas = {
  [key: string]: {
    description?: string;
    properties?: {
      [key: string]: JSONSchema7;
    };
  };
};

export type ContextSchema = JSONSchema7 & { type: 'object' };

export type ConvertToJSONSchemas<T> = {
  [K in keyof T]: {
    properties: { type: { const: K } } & Prop<T[K], 'properties'>;
    type: 'object';
    required: Array<(keyof Prop<T[K], 'properties'> & string) | 'type'>;
    additionalProperties: false;
  };
} & {};

export function createEventSchemas<T extends EventSchemas>(
  eventSchemaMap: T
): ConvertToJSONSchemas<T> {
  const resolvedEventSchemaMap = {};

  for (const [key, schema] of Object.entries(eventSchemaMap)) {
    // @ts-ignore
    resolvedEventSchemaMap[key] = {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          const: key,
        },
        ...schema.properties,
      },
      additionalProperties: false,
      ...schema,
    } as JSONSchema7;
  }

  return resolvedEventSchemaMap as ConvertToJSONSchemas<T>;
}

export type InferEventsFromSchemas<T extends ConvertToJSONSchemas<any>> =
  FromSchema<Values<T>>;
