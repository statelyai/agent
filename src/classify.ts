import type { ClassifyConfig } from './types.js';

/**
 * Create a classification state. Sugar over `decide` for simple routing —
 * categories with descriptions, no per-option schemas.
 *
 * `result.category` is typed as a union of the `into` keys.
 *
 * Note: context in prompt callback is untyped. For typed context, use
 * inline `type: 'choice'` instead.
 */
export function classify<
  const TCategories extends Record<string, { description: string }>,
>(config: ClassifyConfig<TCategories>): any {
  const decideOptions: Record<string, { description: string }> = {};
  for (const [key, val] of Object.entries(config.into)) {
    decideOptions[key] = { description: val.description };
  }

  return {
    __type: 'classify',
    __classifyConfig: config,
    __decideConfig: {
      model: config.model,
      adapter: config.adapter,
      prompt: config.prompt,
      options: decideOptions,
      onDone: ({ result, context }: any) => {
        return config.onDone({
          result: { category: result.choice },
          context,
        });
      },
    },
    on: config.on,
  };
}
