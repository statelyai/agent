import { z } from 'zod';
import { decide } from './decide.js';
import type {
  ClassifyOptions,
  ClassifyResultFor,
  StandardSchemaV1,
} from './types.js';

export async function classify<
  const TCategories extends Record<string, { description: string }>,
>(
  options: ClassifyOptions<TCategories>
): Promise<ClassifyResultFor<TCategories>> {
  const result = await decide({
    adapter: options.adapter,
    model: options.model,
    prompt: buildClassificationPrompt(options.prompt, options.examples),
    options: options.into,
    reasoning: options.reasoning,
  });

  return {
    category: result.choice as keyof TCategories & string,
  };
}

function buildClassificationPrompt(
  prompt: string,
  examples: Array<{ input: string; category: string }> | undefined
): string {
  if (!examples?.length) {
    return prompt;
  }

  return [
    prompt,
    '',
    'Examples:',
    ...examples.map((example) => `${example.category}: ${example.input}`),
  ].join('\n');
}

export function classifyResultSchema<
  const TCategories extends Record<string, { description: string }>,
>(
  into: TCategories
): StandardSchemaV1<ClassifyResultFor<TCategories>> {
  const categories = Object.keys(into);
  if (categories.length === 0) {
    throw new Error('classifyResultSchema requires at least one category');
  }

  const categorySchema =
    categories.length === 1
      ? z.literal(categories[0]!)
      : z.union(
          categories.map((category) => z.literal(category)) as [
            z.ZodLiteral<string>,
            z.ZodLiteral<string>,
            ...z.ZodLiteral<string>[],
          ]
        );

  return z.object({
    category: categorySchema,
  }) as unknown as StandardSchemaV1<ClassifyResultFor<TCategories>>;
}
