import { AnyMachineSnapshot, AnyStateNode, Prop, Values } from 'xstate';
import { FromSchema } from 'json-schema-to-ts';
import { JSONSchema } from 'json-schema-to-ts/lib/types/definitions';
import zodToJsonSchema, {
  JsonSchema7ObjectType,
  JsonSchema7Type,
} from 'zod-to-json-schema';
import { ZodEventTypes } from './schemas';
import { z } from 'zod';

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
      [key: string]: JsonSchema7Type;
    };
  };
};

export type ContextSchema = JSONSchema & { type: 'object' };

export type ConvertToJSONSchemas<T> = {
  [K in keyof T]: {
    properties: { type: { const: K } } & Prop<T[K], 'properties'>;
    type: 'object';
    required: Array<(keyof Prop<T[K], 'properties'> & string) | 'type'>;
    additionalProperties: false;
  };
} & JsonSchema7ObjectType;

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
    } as JSONSchema;
  }

  return resolvedEventSchemaMap as ConvertToJSONSchemas<T>;
}

export function createZodEventSchemas<T extends ZodEventTypes>(
  eventSchemaMap: T
): {
  [K in keyof T]: JsonSchema7ObjectType;
} {
  const resolvedEventSchemaMap = {};

  for (const [eventType, zodType] of Object.entries(eventSchemaMap)) {
    // @ts-ignore
    resolvedEventSchemaMap[eventType] = zodToJsonSchema(
      zodType.extend({
        type: z.literal(eventType),
      })
    );
  }

  return resolvedEventSchemaMap as any;
}

export type InferEventsFromSchemas<T extends ConvertToJSONSchemas<any>> =
  FromSchema<Values<T>>;

export function getToolCalls(
  snapshot: AnyMachineSnapshot,
  filter: (eventType: string) => boolean,
  eventSchemas: EventSchemas = {}
): {
  readonly type: 'function';
  readonly eventType: string;
  readonly function: {
    readonly name: any;
    readonly description: any;
    readonly parameters: {
      readonly type: 'object';
      readonly properties: any;
    };
  };
}[] {
  const eventSchemaMap = eventSchemas;
  const transitions = getAllTransitions(snapshot);
  const functionNameMapping: Record<string, string> = {};
  const tools = transitions
    .filter((t) => {
      return filter(t.eventType);
    })
    .map((t) => {
      const name = t.eventType.replace(/\./g, '_');
      functionNameMapping[name] = t.eventType;
      const eventSchema = eventSchemaMap[t.eventType];
      const {
        description,
        properties: { type, ...properties },
      } = (eventSchema as any) ?? {};

      return {
        type: 'function',
        eventType: t.eventType,
        function: {
          name,
          description: t.description ?? description,
          parameters: {
            type: 'object',
            properties: properties ?? {},
          },
        },
      } as const;
    });
  if (!tools.length) {
    return [];
  }

  return tools;
}
