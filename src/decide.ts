import { z } from 'zod';
import { validateSchemaSync } from './utils.js';
import type {
  AgentAdapter,
  DecideOptions,
  DecideResultFor,
  StandardSchemaV1,
} from './types.js';

export async function decide<
  const TOptions extends Record<string, { description: string; schema?: import('./types.js').StandardSchemaV1 }>,
>(
  options: DecideOptions<TOptions>
): Promise<DecideResultFor<TOptions>> {
  const adapter = requireAdapter(options.adapter, 'decide()');
  const result = await adapter.decide({
    model: options.model,
    prompt: options.prompt,
    options: options.options,
    reasoning: options.reasoning,
  });

  const chosen = options.options[result.choice];
  if (!chosen) {
    throw new Error(
      `Adapter returned unknown decision '${result.choice}' for model '${options.model}'`
    );
  }

  const data = chosen.schema
    ? validateSchemaSync(chosen.schema, result.data)
    : {};

  return {
    choice: result.choice,
    data,
    reasoning: result.reasoning,
  } as DecideResultFor<TOptions>;
}

export function requireAdapter(
  adapter: AgentAdapter | undefined,
  label: string
): AgentAdapter {
  if (!adapter) {
    throw new Error(`No adapter configured for ${label}`);
  }

  return adapter;
}

export function decideResultSchema<
  const TOptions extends Record<string, { description: string; schema?: StandardSchemaV1 }>,
>(
  options: TOptions,
  config: { reasoning?: boolean } = {}
): StandardSchemaV1<DecideResultFor<TOptions>> {
  const schemas = Object.entries(options).map(([choice, option]) =>
    z.object({
      choice: z.literal(choice),
      data: option.schema ? toZodSchema(option.schema) : z.object({}),
      ...(config.reasoning ? { reasoning: z.string().optional() } : {}),
    })
  );

  if (schemas.length === 0) {
    throw new Error('decideResultSchema requires at least one option');
  }

  return (schemas.length === 1
    ? schemas[0]!
    : z.union(
        schemas as unknown as [
          z.ZodTypeAny,
          z.ZodTypeAny,
          ...z.ZodTypeAny[],
        ]
      )) as unknown as StandardSchemaV1<DecideResultFor<TOptions>>;
}

function toZodSchema(schema: StandardSchemaV1): z.ZodTypeAny {
  if ('_zod' in schema || '_def' in schema) {
    return schema as unknown as z.ZodTypeAny;
  }

  return z.record(z.string(), z.unknown());
}
