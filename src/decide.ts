import type { DecideConfig, StandardSchemaV1 } from './types.js';

/**
 * Create a decision state where an LLM picks from constrained options.
 * Each option has a description and optional schema for structured data.
 *
 * The result type is a discriminated union — `result.choice` narrows `result.data`.
 *
 * Note: context in prompt callback is untyped. For typed context, use
 * inline `type: 'choice'` instead.
 */
export function decide<
  const TOptions extends Record<
    string,
    { description: string; schema?: StandardSchemaV1 }
  >,
>(config: DecideConfig<TOptions>): any {
  return {
    __type: 'decide',
    __decideConfig: config,
    on: config.on,
  };
}
