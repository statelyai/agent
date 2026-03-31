import type { ClassifyConfig, StateConfig } from './types.js';

/**
 * Create a classification state. Sugar over `decide` for simple routing —
 * categories with descriptions, no per-option schemas.
 */
export function classify(config: ClassifyConfig): StateConfig {
  // Convert classify categories into decide options
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
      onDone: ({ result, context }) => {
        // Transform decide result → classify result
        return config.onDone({
          result: { category: result.choice },
          context,
        });
      },
    },
    on: config.on,
  };
}
