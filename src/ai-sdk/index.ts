import { generateObject } from 'ai';
import { z } from 'zod';
import type { AgentAdapter, StandardSchemaV1 } from '../types.js';

/**
 * Create an adapter that uses the Vercel AI SDK for decide/classify.
 * Model strings like 'anthropic/claude-sonnet-4.5' are resolved via the
 * AI SDK's model registry.
 */
export function createAiSdkAdapter(): AgentAdapter {
  return {
    async decide({ model, prompt, options, reasoning }) {
      // Build the discriminated union schema for options
      const optionKeys = Object.keys(options);

      // Build per-option schemas
      const optionSchemas: Record<string, z.ZodType> = {};
      for (const [key, opt] of Object.entries(options)) {
        if (opt.schema) {
          // Use the provided schema as the data shape
          optionSchemas[key] = z.object({
            choice: z.literal(key),
            data: toZodSchema(opt.schema),
            ...(reasoning ? { reasoning: z.string().describe('Chain-of-thought reasoning for this decision') } : {}),
          });
        } else {
          optionSchemas[key] = z.object({
            choice: z.literal(key),
            data: z.object({}),
            ...(reasoning ? { reasoning: z.string().describe('Chain-of-thought reasoning for this decision') } : {}),
          });
        }
      }

      // Build the union schema
      const schemas = optionKeys.map((k) => optionSchemas[k]!);
      const schema =
        schemas.length === 1
          ? schemas[0]!
          : z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);

      // Build the system prompt with option descriptions
      const optionDescriptions = Object.entries(options)
        .map(([key, opt]) => `- ${key}: ${opt.description}`)
        .join('\n');

      const systemPrompt = `You must choose exactly one of the following options:\n${optionDescriptions}\n\nRespond with your choice and any required data.`;

      const result = await generateObject({
        model: resolveModel(model),
        system: systemPrompt,
        prompt,
        schema,
      });

      const obj = result.object as {
        choice: string;
        data: Record<string, unknown>;
        reasoning?: string;
      };

      return {
        choice: obj.choice,
        data: obj.data ?? {},
        reasoning: obj.reasoning,
      };
    },
  };
}

/**
 * Convert a StandardSchemaV1 to a zod schema.
 * If it's already a zod schema, return as-is.
 * Otherwise, fall back to z.record for basic compatibility.
 */
function toZodSchema(schema: StandardSchemaV1): z.ZodType {
  // Check if it's already a zod schema (has _zod property in v4)
  if ('_zod' in schema || '_def' in schema) {
    return schema as unknown as z.ZodType;
  }
  // Fallback: accept any object
  return z.record(z.string(), z.unknown());
}

/**
 * Resolve a model string to an AI SDK model.
 * Supports the `provider/model` format via the AI SDK registry.
 */
function resolveModel(model: string): Parameters<typeof generateObject>[0]['model'] {
  // The AI SDK accepts model strings when using a provider registry.
  // For now, return as-is — users configure their provider registry externally.
  return model as any;
}
