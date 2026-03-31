import type { DecideConfig, StateConfig } from './types.js';

/**
 * Create a decision state where an LLM picks from constrained options.
 * Each option has a description and optional schema for structured data.
 */
export function decide(config: DecideConfig): StateConfig {
  return {
    __type: 'decide',
    __decideConfig: config,
    on: config.on,
  };
}
